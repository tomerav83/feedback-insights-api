# feedback-insights-api

A backend service that ingests free-text user feedback and reliably extracts structured insights
(sentiment, feature requests, an actionable insight) using an LLM. Submission is non-blocking:
the POST returns immediately and analysis runs asynchronously in an in-process worker. Every model
response is forced toward a strict schema, **re-validated defensively with Zod**, and persisted in
both raw and structured form. Failures are explicit terminal states and are retriable. A read API
exposes each feedback item with its status and latest analysis.

It runs **fully offline by default** — with no API key, no network, and no cost — against a
deterministic fake LLM, so the whole pipeline and test suite are reproducible. Pointing it at any
OpenAI-compatible endpoint (local Ollama or a hosted tier) makes it live.

---

## Quick start

Requires **Node 22** (pinned in `.nvmrc`; the native `better-sqlite3` build needs it). Any install
method works — [official installer](https://nodejs.org/), Homebrew (`brew install node@22`), etc. If
you use [nvm](https://github.com/nvm-sh/nvm) (`.nvmrc` is provided for it):

```bash
# Install nvm if you don't have it, then pick up the pinned version:
#   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install        # reads .nvmrc -> installs + uses Node 22.22.3 (use `nvm use` if already installed)
```

Then, from the repo root:

```bash
npm install
npm start          # tsx src/index.ts — runs offline against the deterministic fake LLM
```

The server listens on `:3000`. No `.env` is needed to run — with `LLM_BASE_URL` unset it uses the
fake backend, so `npm start` and the entire test suite work with zero key / zero network / zero cost.

```bash
npm test           # vitest — offline, against the fake LLM
npm run typecheck  # tsc --noEmit
npm run dev        # tsx watch (reload on change)
./demo/demo.sh     # curl walkthrough — drives the full flow end-to-end against the running server
```

Example requests:

```bash
# Submit feedback — returns 202 immediately, analysis runs async
curl -s -XPOST localhost:3000/feedback \
  -H 'content-type: application/json' \
  -d '{"content":"The export button is broken and I wish there was a dark mode."}'
# -> 202 {"id":"...","status":"RECEIVED"}

# List feedback with latest analysis (filter + paginate)
curl -s 'localhost:3000/feedback?status=DONE&limit=10&offset=0'

# Fetch one item + its latest analysis
curl -s localhost:3000/feedback/<id>

# Re-drive a FAILED item
curl -s -XPOST localhost:3000/feedback/<id>/retry
```

`demo/demo.sh` (a scripted curl sequence) drives this full flow end-to-end, including the failure
paths, and is the fastest manual smoke test of the whole system. For a hands-off, two-backend
walkthrough (real model **and** the deterministic failure path) that starts and stops its own
servers, see [Demo](#demo) and `demo/demo-all.sh`.

---

## Configuration

All config is read from the environment through a single Zod-validated choke point (`src/config.ts`),
which fails fast on bad values. See `.env.example` for the full list; the defaults are sensible.

| Var | Default | Purpose |
|---|---|---|
| `LLM_BASE_URL` | _unset_ | **Unset → deterministic offline fake.** Set it → live OpenAI-compatible client. |
| `LLM_MODEL` | `llama3.1` | Model name passed to the live backend. |
| `LLM_API_KEY` | _unset_ | Server-side key; only needed for hosted backends (Ollama needs none). |
| `PORT` | `3000` | HTTP port. |
| `DB_PATH` | `./data.db` | SQLite file. |
| `MAX_CONTENT_LENGTH` | `8000` | Defensive input cap, enforced at the API boundary before any LLM call. |
| `MAX_AUTO_RETRIES` | `2` | Bounded auto-retries on transient LLM errors before → FAILED. |
| `WORKER_CONCURRENCY` | `2` | In-process worker concurrency. |

### Going live

The same client works against **any OpenAI-compatible endpoint** — no provider lock-in:

```bash
# Local, no key (recommended for a live demo)
LLM_BASE_URL=http://localhost:11434/v1   LLM_MODEL=llama3.1

# Hosted free tier (Groq)
LLM_BASE_URL=https://api.groq.com/openai/v1   LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct   LLM_API_KEY=<key>
```

The live client forces OpenAI `response_format: json_schema` (strict), so the model **must support
structured output**. On Groq, `llama-4-scout` and `gpt-oss-20b` accept `json_schema`;
`llama-3.3-70b-versatile` and `qwen3-32b` do **not** and will error. `GET /health` reports which
backend is active (`{"llm":"live"}` or `{"llm":"fake"}`).

---

## Demo

The `demo/` directory holds two scripts:

| Script | What it does |
|---|---|
| `demo/demo.sh` | The walkthrough itself — a narrated `curl` sequence against a server **you** already started. |
| `demo/demo-all.sh` | An orchestrator that runs `demo.sh` in two phases, starting/stopping its own servers and cleaning up. |

Both pause between steps so the output is readable on screen (press Enter to advance, or set
`STEP_DELAY=<seconds>` to auto-advance). `demo.sh` also takes `STEPS=<comma-list>` to run a subset
(e.g. `STEPS=1,5` = health + the FAILED/retry path).

`demo-all.sh` runs:

- **Phase 1 — live** (uses your `.env`): the happy path against a real model.
- **Phase 2 — fake** (forces `LLM_BASE_URL=`): the deterministic `FAILED → retry` path (a real model
  won't reproduce it — it ignores the fake's `__FAIL_SCHEMA__` failure-injection sentinel).

Each phase runs on a throwaway DB + port (`3201`/`3202`), so your real `data.db` and port `3000` are
untouched, and an `EXIT`/`INT`/`TERM` trap guarantees the server is stopped and the temp DB removed
even on Ctrl-C.

### Running `demo-all.sh` on a clean environment

From a fresh clone:

```bash
# 1. Node 22 (the native better-sqlite3 build needs it)
nvm install                 # or install Node 22 any other way

# 2. Install dependencies (compiles better-sqlite3)
npm install

# 3. (Optional) configure a REAL backend for phase 1. Without this, phase 1 also runs
#    against the offline fake — the demo still works, it just isn't a real model.
cp .env.example .env
#    then edit .env, e.g. for Groq's free tier:
#      LLM_BASE_URL=https://api.groq.com/openai/v1
#      LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
#      LLM_API_KEY=<your free key>

# 4. Run the two-phase demo (interactive — press Enter between steps)
./demo/demo-all.sh
#    …or hands-off, auto-advancing every 3s (good for an unattended recording):
STEP_DELAY=3 ./demo/demo-all.sh
```

Requirements: `bash`, `curl` (and Node 22 + `npm install` as above). `jq` is optional — the scripts
fall back to raw JSON if it's absent.

> Tip: to demo a single backend against a server you control instead, start it yourself
> (`LLM_BASE_URL= npm start` for the fake, or `npm start` with a configured `.env` for live) and run
> `BASE=http://localhost:3000 ./demo/demo.sh`.

### Demo recording

<!-- DEMO VIDEO: replace the line below with your recording.
     Easiest: open this README on github.com, click the pencil (Edit), and drag the
     .mp4/.mov into the editor — GitHub uploads it and inserts a
     https://github.com/<owner>/<repo>/assets/... link that renders an inline player.
     Alternatively link a hosted video (YouTube/Loom):
       [![Watch the demo](docs/demo-thumbnail.png)](https://youtu.be/VIDEO_ID) -->

_Demo video: to be added._

---

## How it works

```
                                ┌──────────────────────── in-process queue ───────────────────────┐
POST /feedback                  │                                                                  │
  → validate (Zod)              │   worker claims item (CAS RECEIVED→ANALYZING)                    │
  → sha256(trimmed content)     │     → LLM call (json_schema nudge)                               │
  → dedupe by content_hash      │     → Zod re-validate  ─┬─ valid     → persist raw+structured, DONE
  → INSERT status=RECEIVED      │                         ├─ invalid   → persist raw+error, FAILED
  → enqueue                     │                         └─ transient → bounded backoff retry,
  → 202 {id, status:RECEIVED}   │                                          else FAILED
                                └──────────────────────────────────────────────────────────────────┘

State machine:   RECEIVED ──► ANALYZING ──► DONE
                                  │
                                  └────────► FAILED ──(POST /feedback/:id/retry)──► RECEIVED
```

The web layer (Fastify) only validates, dedupes, persists, and enqueues — then returns `202`. A
worker pulls each item, transitions it to `ANALYZING`, calls the LLM, and resolves it to a terminal
state.

**Defense in depth.** The live client asks the backend for `json_schema` structured output, but the
worker treats that as a *nudge*, not a guarantee: every response (fake or live, constrained or not)
is re-validated with Zod before it can reach `DONE`. Anything that fails — non-JSON, wrong enum,
extra keys, out-of-range confidence, empty insight — becomes a `FAILED` row with the **raw response
still persisted**, never a crash. Both the raw model output and the validated structured fields are
stored on every attempt (a hard requirement), so retry history is preserved.

**Crash recovery.** On boot, rows stuck in `ANALYZING` (a crash mid-analysis) are reset and
re-enqueued, and pending non-terminal rows are picked back up, so the pipeline self-heals on restart.

---

## API reference

| Method | Path | Success | Other |
|---|---|---|---|
| `POST` | `/feedback` | `202 {id, status:'RECEIVED'}` | `200 {id, status, deduplicated:true}` on hash hit; `400` invalid/over-length |
| `GET` | `/feedback` | `200 {items, limit, offset}` | supports `?status=`, `?limit=`, `?offset=` |
| `GET` | `/feedback/:id` | `200` item + latest analysis | `404` if missing |
| `POST` | `/feedback/:id/retry` | `202` (FAILED → RECEIVED) | `409` if not FAILED; `404` if missing |
| `GET` | `/health` | `200 {status:'ok', llm:'live'\|'fake'}` | — |

---

## Design decisions & tradeoffs

- **Guardrail = content-hash dedupe.** `POST /feedback` hashes the trimmed content (sha256) and
  returns the existing record on a hit instead of inserting + re-analyzing. A `UNIQUE` index on
  `content_hash` makes this DB-enforced and a race backstop for concurrent identical submits.
  *Rejected:* rate-limiting (protects budget, not consistency) and cache-only (a subset of this).
  The rubric explicitly grades data/state consistency, which this touches directly.

- **Dedupe returns the existing item even when it's `FAILED`.** Resubmitting failed content gives
  back the old record (with its real `status` visible in the response), *not* a fresh analysis —
  re-driving a failure is the job of `POST /feedback/:id/retry`, the explicit escape hatch.
  *Rejected:* re-analyze-on-resubmit, which reintroduces the duplicate work the guardrail exists to
  prevent and muddies idempotency.

- **Zod is the real enforcement boundary; `json_schema` is a best-effort nudge.** OpenAI strict
  structured-output mode supports only a subset of JSON Schema — it ignores/rejects numeric
  `minimum`/`maximum` and string `minLength`. So our two most interesting constraints
  (`confidence ∈ [0,1]`, non-empty `actionable_insight`) are **not** enforced by the model layer;
  only the Zod re-validation enforces them. We therefore re-validate every response regardless of
  what the backend claims to guarantee — defense in depth.

- **In-process queue, not durable — mitigated by boot recovery.** A custom ~50-line queue + worker
  (bounded concurrency, exponential backoff) keeps the entire state machine in our own code with no
  Redis/broker dependency. *Rejected:* BullMQ (needs Redis = overbuild), p-queue (concurrency only,
  no retry/transitions). The in-memory queue itself is not durable, but every submission is persisted
  as a row *before* the `202`, so boot recovery rebuilds the work set from the DB: it resets stuck
  `ANALYZING` rows to `RECEIVED` and then re-enqueues **every** non-terminal (`RECEIVED`) row —
  including pending items dropped from the in-memory queue on shutdown, not just the ones it reset —
  so nothing submitted is lost across a restart.

- **Schema-invalid → `FAILED` immediately, no reprompt.** A malformed model response is persisted
  (raw + error) and marked `FAILED` rather than looping. *Rejected:* auto-reprompting, which burns
  tokens against a misbehaving model. Manual `/retry` covers the recovery case. (Transient
  infra errors — network/timeout/429/5xx — *do* get bounded auto-retry with backoff first.)

- **Transport/validation split.** The `LLMClient` does HTTP + `JSON.parse` only and throws *only*
  for retryable infrastructure failures; a malformed body is a normal return. The worker owns Zod
  validation. This one split lets a single code path map two failure kinds onto different terminal
  states (transient → retry-then-FAILED; schema-invalid → FAILED now) and keeps the defensive layer
  shared between the real and fake clients.

- **Atomic terminal write.** Persisting the `analyses` row and flipping out of `ANALYZING` happen in
  one transaction (`finishAttempt`, a guarded CAS + insert). Two statements would let a crash land
  between them — an analysis written while still `ANALYZING`, which boot recovery then re-runs,
  producing a duplicate analysis and wasted spend. Atomicity means an attempt is persisted iff its
  transition committed.

- **Raw `better-sqlite3` behind a repository.** Synchronous, zero-config, trivial transactions, and
  a free `UNIQUE` index for the guardrail. *Rejected:* Drizzle/Prisma (tooling friction in a 3h box).
  The repository module localizes persistence so an ORM swap is one file. Less type-safety at the
  query line is the accepted cost.

- **Structured result stored as JSON text.** `feature_requests` is persisted as a JSON string, so it
  is *not* independently queryable by feature. Fine for this scope; a normalized child table is the
  fix if query-by-feature ever matters.

---

## Secret handling

The LLM key is a server-side operator secret; the end user never supplies or sees it. The assume-breach
posture closes the cheap, high-impact leak vectors in scope:

- **Never in source.** Read only from `process.env` via `.env` (git-ignored); only `.env.example`
  (placeholders) is committed.
- **One choke point.** Only `config.ts` reads `process.env`; the key is read once and handed solely
  to the client constructor.
- **Never logged.** Kept out of any logged object; no `console.log(config)`; pino redaction configured.
- **Never reflected.** No debug/config route; `/health` returns only `llm: 'live' | 'fake'`, never the
  value.
- **No-secret happy path.** The fake (default) and local Ollama backends need no key at all, so the
  leak surface is often zero.

**Production deltas (not built in a 3h box):** a secrets manager instead of `.env`, never baking the
key into a Docker layer, plus a dedicated key with spend cap, rotation, and revocation.

---

## Tests

`npm test` runs Vitest **offline against the fake LLM** — no key, no network, fully deterministic.
The fake recognizes double-underscore sentinels in the content (`__FAIL_PARSE__`, `__FAIL_SCHEMA__`,
`__FAIL_TRANSIENT__`) to drive each defensive branch on demand, so every state-machine edge has an
offline test. Coverage spans: the `RECEIVED → ANALYZING → DONE|FAILED` flow, schema valid/invalid
handling, content-hash dedupe, the endpoints and their status codes, `/retry` semantics
(`FAILED→RECEIVED` vs `409`), and boot recovery of stuck rows.

---

## AI Collaboration Log

**Tool:** Claude Code (Opus 4.8) for the entire build, via an iterative plan-then-implement loop.
The stack and architecture (tech choices with rejected alternatives, the state machine, env config)
were settled with it up front, then the system was implemented and checkpointed in small slices —
data layer, vertical slice against the fake LLM, real client, guardrail/retry, read API, tests. The
design decisions captured during the build are distilled into the section above.

### Example prompts relied on

1. **Stack decision.** "Pick a stack for a 3-hour timebox; justify each choice and name the rejected
   alternative for each layer. Optimize explicitly for the rubric's priorities — correctness, state
   consistency, and AI-integration quality first." → produced the tech-stack table (Fastify over
   Express/Nest, raw better-sqlite3 over an ORM, custom queue over BullMQ) with the rejected option
   recorded for each.

2. **Defensive LLM output.** "Enumerate the adversarial model outputs we must survive — non-JSON,
   wrong enum, out-of-range confidence, missing/extra keys — and make each one a `FAILED` row with
   the raw response persisted, never a crash." → drove the transport/validation split and the
   sentinel-based fake that exercises each branch offline.

3. **Secret handling (assume-breach).** "Enumerate the key-leak vectors — git, logs, API responses —
   close the cheap high-impact ones in scope, and document the rest as production deltas." → produced
   the single-choke-point config, pino redaction, and the `live|fake`-only `/health`.

### One concrete case where the AI was wrong, and how I constrained it

The AI's initial plan for the LLM client assumed `response_format: { type: 'json_schema', strict: true }`
would **enforce** the interesting constraints — `confidence ∈ [0,1]` and a non-empty `actionable_insight`.
That is false: OpenAI strict structured-output mode supports only a *subset* of JSON Schema. It
ignores/rejects numeric `minimum`/`maximum` and string `minLength`, and a strictly-validating backend
can return **400 ("unsupported keyword")** when the generated schema carries them. Trusting the model
layer would have silently let out-of-range and empty values through, and could have 400-ed every
request on some backends.

The correction: **strip the unsupported keywords** so the schema sent to the model is structural-only,
treat `json_schema` as a best-effort *nudge*, and make **Zod re-validation the real enforcement
boundary** (defense in depth) — bounds and non-emptiness are checked in Zod, not delegated to the
model. A keyword-400 is also treated as a *config* error, not a per-item `FAILED`, so it surfaces
loudly instead of masquerading as bad model output.

A second, smaller catch from the same review: the AI's first async design recovered only `ANALYZING`
rows on boot. Review caught that an item dropped from the in-process queue on shutdown is still
`RECEIVED` (it was never marked `ANALYZING`), so it would be orphaned forever; recovery was widened to
sweep all non-terminal rows.

### What I'd improve with more time

- **Durable / external queue** (a broker, or polling the DB as the queue). Boot recovery already
  rebuilds the work set from persisted rows, but a real queue would drop the in-memory scan, support
  multiple worker processes, and give at-least-once delivery without relying on a restart.
- **One stricter reprompt** on schema-invalid output before giving up (currently fail-fast to avoid
  token-burn loops).
- **Normalized `feature_requests` table** for query-by-feature instead of JSON text.
- **Richer observability** — per-state metrics, attempt-count histograms — and broader test coverage.
