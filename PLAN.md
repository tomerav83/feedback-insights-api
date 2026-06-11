<plan version="1.0" last-updated="2026-06-11" timebox="3h" owner="Tomer Aviram">

<objective>
Build a backend-driven service that accepts free-text user feedback and reliably extracts
structured insights with an LLM. Submission is non-blocking; AI analysis runs asynchronously
in-process. AI output is forced into a strict schema, validated defensively, and persisted
(both raw and structured). Failures are explicit and retriable. A read API exposes feedback
with status and analysis.

This is a backend + judgment exercise. No UI, no auth, no deployment, no exhaustive tests.
</objective>

<constraints>
- Timebox: 3 hours. Do NOT overbuild — make conscious tradeoffs and document them.
- All code is written via an AI assistant (this Claude Code session) — the AI Collaboration Log is authentic.
- Deliverables: code + README (setup, design decisions, tradeoffs) + AI Collaboration Log.
- Persistence: SQLite is sufficient.
</constraints>

<evaluation-priorities note="design choices are made to serve these, in order">
1. Engineering judgment & correctness
2. Data and state consistency (the RECEIVED -> ANALYZING -> DONE|FAILED machine)
3. Quality of AI integration: forced structured output, validation, failures, retries
4. Ability to deliver quickly using AI
5. Clarity of explanations and tradeoffs (README + Collaboration Log weighted as heavily as code)
</evaluation-priorities>

<tech-stack>
| Layer | Choice | Rationale / rejected alternative |
|---|---|---|
| Language | TypeScript (run via `tsx`, typecheck `tsc --noEmit`) | Types de-risk the state machine + schema handling the rubric grades. No dev build step. |
| Web framework | Fastify | Schema-first, fast, first-class TS, `onClose` lifecycle hook to gracefully stop the worker. Rejected: Express (no built-in validation, dated), Nest (DI/decorators = overbuild), Hono (worse fit for long-lived worker + native SQLite). |
| Validation | Zod | The challenge IS a schema-validation exercise. One definition -> runtime validation + inferred types. Used at every boundary (request body AND LLM output). |
| LLM output | Provider-agnostic OpenAI-compatible client (`openai` SDK + configurable `baseURL`); forced structured output via `response_format: json_schema` (schema derived from the Zod model via `zod-to-json-schema`), then re-validated with Zod | One client works against any OpenAI-protocol backend (Ollama local / Groq / Gemini free tiers) by changing env — no provider lock-in, no required spend. `json_schema` constrains the model to the schema; re-validating anyway is the defensive move (never trust the model even when constrained). Rejected: Anthropic SDK (mandates a paid key the spec never requires). |
| Persistence | better-sqlite3 (raw, synchronous) behind a repository module | Rubric gives no points for ORM sophistication and real points for delivering quickly + correctness. Zero-config, trivial transactions, and a UNIQUE index on content-hash gives the dedupe guardrail for free. Repository isolates persistence so an ORM swap is one file. Rejected: Drizzle/Prisma (tooling friction in a 3h box). |
| Async queue | Custom in-process queue + worker (bounded concurrency + retry) | ~50 lines we fully own; retry/backoff + state transitions are bespoke. Rejected: p-queue (concurrency only), BullMQ (needs Redis = overbuild). |
| Tests | Vitest, against the fake LLM | TS-native, fast, good mocking. A handful of high-value tests only. |
| Config | Zod-validated `process.env` (+ `.env` via dotenv) | Single choke point; fail-fast on bad config. |
</tech-stack>

<architecture>
Data flow:
  POST /feedback -> validate -> hash -> (dedupe check) -> INSERT status=RECEIVED -> enqueue -> 202
  worker pulls -> status=ANALYZING -> LLM call (json_schema) -> Zod validate
    -> valid:   persist raw + structured, status=DONE
    -> invalid: persist raw + error, status=FAILED
    -> transient error: bounded auto-retry w/ backoff, else status=FAILED
  GET /feedback, GET /feedback/:id -> read status + analysis
  POST /feedback/:id/retry -> re-enqueue a FAILED item

Module layout:
  src/
    index.ts                      entrypoint: build server, listen, wire shutdown
    server.ts                     Fastify app; starts/stops worker via lifecycle hooks
    config.ts                     zod-validated env (single reader of process.env)
    db/
      client.ts                   better-sqlite3 instance
      migrate.ts                  CREATE TABLE ... on boot (idempotent)
    schemas/
      feedback.ts                 request DTOs + feedback response shape
      analysis.ts                 STRICT AIAnalysis zod schema (the contract)
    repositories/
      feedback.repo.ts            CRUD, hash lookup, status transitions, recover-stuck
    queue/
      queue.ts                    in-process queue + worker loop (concurrency, retry)
    worker/
      analyze.ts                  process one item end-to-end
    llm/
      types.ts                    LLMClient interface
      openai-compatible.ts        real client (OpenAI-protocol; works w/ Ollama/Groq/Gemini)
      fake.ts                     deterministic fake (offline + tests, default when unconfigured)
      factory.ts                  pick real vs fake based on env
    routes/
      feedback.routes.ts          POST/GET/GET/POST endpoints
      health.routes.ts            GET /health -> { status, llm: 'live'|'fake' }
  tests/                          vitest specs
  README.md  .env.example  package.json  tsconfig.json
</architecture>

<data-model note="store structured result as JSON text in SQLite; document that feature_requests is not independently queryable (acceptable tradeoff)">
feedback
  id            TEXT PRIMARY KEY      -- crypto.randomUUID()
  content       TEXT NOT NULL
  content_hash  TEXT NOT NULL UNIQUE  -- sha256(content); enforces dedupe at DB layer
  status        TEXT NOT NULL         -- RECEIVED | ANALYZING | DONE | FAILED
  created_at    TEXT NOT NULL         -- ISO 8601
  updated_at    TEXT NOT NULL

analyses (one row per attempt -> preserves retry history)
  id            TEXT PRIMARY KEY
  feedback_id   TEXT NOT NULL REFERENCES feedback(id)
  attempt       INTEGER NOT NULL
  raw_response  TEXT                  -- raw model output (persisted even when invalid)
  sentiment     TEXT                  -- positive | neutral | negative (nullable)
  feature_requests TEXT               -- JSON array string (nullable)
  actionable_insight TEXT             -- nullable
  valid         INTEGER NOT NULL      -- 0|1 schema validation result
  error         TEXT                  -- failure reason (nullable)
  created_at    TEXT NOT NULL

Read API joins the latest analysis onto each feedback item.
</data-model>

<state-machine>
States: RECEIVED -> ANALYZING -> DONE | FAILED

Transitions:
  RECEIVED  -> ANALYZING : worker picks up the item
  ANALYZING -> DONE      : LLM output passes Zod validation; structured result persisted
  ANALYZING -> FAILED    : schema-invalid output, OR transient error after retries exhausted
  FAILED    -> RECEIVED  : POST /feedback/:id/retry re-enqueues (manual)

Retry policy:
  - Transient errors (network, timeout, 429, 5xx): bounded auto-retry with exponential
    backoff, maxAutoRetries (default 2). On exhaustion -> FAILED (manually retriable).
  - Schema-invalid output: persist raw + error, mark FAILED immediately (do not burn tokens
    looping on a misbehaving model). Surfaced for manual /retry.
  - Crash recovery: on boot, any row stuck in ANALYZING is reset to RECEIVED and re-enqueued.
</state-machine>

<api>
| Method | Path | Behavior |
|---|---|---|
| POST | /feedback | Validate body; reject empty / over-length (defensive cap). Dedupe by hash -> return existing if found. Else INSERT RECEIVED + enqueue. Returns 202 `{ id, status }`. |
| GET | /feedback | List feedback with status + latest analysis. Optional `?status=` filter and `?limit=&offset=` pagination. |
| GET | /feedback/:id | Single feedback with status + analysis; 404 if missing. |
| POST | /feedback/:id/retry | Re-enqueue a FAILED item -> RECEIVED. 409 if not in FAILED. |
| GET | /health | `{ status:'ok', llm:'live'|'fake' }` — never reveals the key. |
</api>

<ai-integration>
- Provider-agnostic: one OpenAI-compatible client (`openai` SDK with a configurable `baseURL`).
  Works unchanged against any OpenAI-protocol backend by switching env: Ollama (local, $0, no key,
  offline), or a free hosted tier (Groq / Gemini). The spec requires "an LLM," not Anthropic.
- Default backend: deterministic fake when no LLM_BASE_URL is configured. So `npm start` runs the
  full pipeline with zero key / zero setup / zero cost; tests run against the fake too.
- Forced structured output via `response_format: { type: 'json_schema', json_schema: { strict: true,
  schema: <AIAnalysis JSON Schema> } }`, derived from the Zod model via zod-to-json-schema.
  (Fallback for backends lacking json_schema: tool/function-calling with the same schema, or
  json_object mode + Zod. The Zod re-validation makes all three equivalent in safety.)
- Defense in depth: re-validate the model output with Zod even though json_schema constrains it.
- Strict schema (the contract):
    {
      "sentiment": "positive | neutral | negative",
      "feature_requests": [ { "title": "string", "confidence": 0.0 } ],
      "actionable_insight": "string"
    }
  Zod enforces: sentiment enum, feature_requests array of {title:string, confidence:number in [0,1]},
  actionable_insight non-empty string. No unknown keys.
- Persist BOTH the raw model response and the validated structured result (per the requirement).
- Note: a local model (Ollama) produces malformed output more often than a frontier model — an asset
  here, not a liability: it yields authentic FAILED cases (bad enum, confidence out of range, non-JSON)
  that exercise the defensive path and feed the Collaboration Log's "AI got it wrong" requirement.
</ai-integration>

<guardrail choice="hash-based dedupe">
Mechanism: sha256(content) stored as content_hash with a UNIQUE index. On POST, look up by
hash; if present, return the existing feedback (and its analysis) instead of creating a new row
and re-analyzing. The UNIQUE index is also a race backstop (concurrent identical submits).

Why this one (vs the other options):
  - Idempotent submissions and avoids redundant, costly LLM calls.
  - Doubles as a results cache keyed by content.
  - Touches "data consistency," which the rubric explicitly grades.
  - DB-enforced, so correctness does not depend on application-level checks alone.
Rejected: rate-limit (protects budget but not consistency), cache-only (subset of dedupe),
token-truncation (least interesting to discuss; we still cap input length defensively anyway).
</guardrail>

<secret-handling rationale="you contain a secret, you don't 'guarantee' it; assume-breach">
LLM_API_KEY (only present when pointing at a hosted backend; the local/Ollama path has NO secret at all)
is the operator's server-side secret; the end-user never supplies or sees it.
In scope for this build (cheap, high-impact — closes the git / logs / endpoint leak vectors):
  - Never in source. Load only from process.env via `.env` (git-ignored); commit `.env.example` placeholder.
  - One choke point: only config.ts reads process.env; key is read once and passed only to the client constructor.
  - Never logged: keep key out of any logged object; configure pino redaction; no console.log(config).
  - Never reflected: no debug/config route; /health returns a boolean (`llm: live|fake`), not the value.
  - Optional, not required: fake fallback means app + tests run with no key; tests never touch the real secret.
  - Best-case has no secret: the recommended local backend (Ollama) needs no key, so the leak surface is zero.
Documented as production delta (not built in 3h): secrets manager not `.env`; never bake key into a
Docker image layer; dedicated key + spend cap + rotation + revocation (assume-breach); `npm ci` + audit
+ minimal deps (supply-chain); optional gitleaks pre-commit hook.
</secret-handling>

<defensive-handling>
Adversarial LLM outputs to survive (each -> FAILED with raw persisted, never a crash):
  - non-JSON / unparseable, missing or extra fields, wrong types
  - sentiment outside the enum
  - confidence out of [0,1] range
  - empty feature_requests (allowed) vs malformed entries (rejected)
  - oversized / empty content (rejected at the API boundary before the LLM call)
Operational robustness:
  - Transient vs permanent failure taxonomy (see state-machine).
  - Stuck-ANALYZING recovery on boot.
  - Bounded concurrency on the worker; graceful shutdown drains/stops via Fastify onClose.
</defensive-handling>

<tradeoffs to-document="in README design-decisions">
- In-process queue is not durable across restarts (items lost on crash) -> mitigated by
  ANALYZING-recovery on boot; production path = persist queue / poll DB or use a broker.
- Raw better-sqlite3 over an ORM: less type-safety at the query line, bought speed + zero config;
  repository pattern localizes any future swap.
- structured result stored as JSON text: not independently queryable by feature; fine for this scope.
- Provider-agnostic OpenAI-compatible client, default fake: $0 to run/grade; live demo via Ollama
  (no key) or a free hosted tier. Rejected Anthropic SDK (would mandate a paid key the spec never asks for).
- Schema-invalid = FAILED immediately rather than auto-reprompting: avoids token-burn loops;
  alternative (one stricter reprompt) noted.
</tradeoffs>

<work-breakdown total="~3h, with a cut-line">
| # | Portion | Deliverable | ~min |
|---|---|---|---|
| P0 | Scaffold | package.json, tsconfig, Fastify boots, zod-validated config, `.env.example`, `.gitignore` | 15 |
| P1 | Data layer | better-sqlite3 client + feedback/analyses tables, repository, zod DTOs + strict AIAnalysis schema | 25 |
| P2 | Vertical slice (fake LLM) | in-process queue + worker, full RECEIVED->ANALYZING->DONE/FAILED, persist results, end-to-end | 35 |
| P3 | Real LLM integration | OpenAI-compatible client (Ollama/Groq) -> json_schema forced JSON -> Zod validate -> persist raw + structured; invalid -> FAILED | 30 |
| P4 | Guardrail + retry | hash dedupe (UNIQUE index), /retry endpoint, transient-vs-permanent semantics, bounded auto-retry | 25 |
| P5 | Read API + hardening | list/detail/filter/pagination, input length cap, stuck-ANALYZING recovery, /health | 20 |
| P6 | Tests (high-value only) | schema valid/invalid, state flow, dedupe, endpoints — via fake LLM | 20 |
| P7 | README + AI Collaboration Log | setup, design decisions, tradeoffs, authentic log + "what I'd improve" | 20 |

Checkpoint after each portion before moving on.
</work-breakdown>

<cut-line>
Non-negotiable: P0-P4 + P7 (every functional requirement + the writeup).
Sacrifice in this order if behind: P6 test breadth -> P5 filtering/recovery -> auto-retry
(keep the manual /retry). Never cut the defensive validation or the README/Collaboration Log.
</cut-line>

<ai-collaboration-log-plan>
Capture during the build (this session is the source material):
  - Tool used: Claude Code (Opus 4.8).
  - 2-3 real prompts relied on (e.g., the stack-decision prompt, the secret-handling prompt).
  - One concrete "AI got it wrong / I constrained it" example, real from the build
    (likely candidate: tightening LLM output handling, or correcting an over-engineered first pass).
  - What I'd improve with more time (durable queue, normalized feature_requests, reprompt-on-invalid,
    richer tests, observability/metrics).
</ai-collaboration-log-plan>

<env-config file=".env.example">
  # LLM backend — all optional. Unset LLM_BASE_URL -> deterministic fake (zero setup/cost).
  # Local, no key:    LLM_BASE_URL=http://localhost:11434/v1        LLM_MODEL=llama3.1                 LLM_API_KEY=ollama
  # Hosted free tier: LLM_BASE_URL=https://api.groq.com/openai/v1   LLM_MODEL=llama-3.3-70b-versatile  LLM_API_KEY=<free key>
  LLM_BASE_URL=             # unset -> fake LLM
  LLM_MODEL=
  LLM_API_KEY=             # not needed for local/Ollama
  PORT=3000
  DB_PATH=./data.db
  MAX_CONTENT_LENGTH=8000
  MAX_AUTO_RETRIES=2
  WORKER_CONCURRENCY=2
</env-config>

<out-of-scope reason="explicitly not graded">
UI polish, authentication, deployment, exhaustive test coverage, external queue/broker,
multi-tenant key handling, migrations tooling.
</out-of-scope>

</plan>
