# Design notes (scratchpad for the README)

Working notes captured during the build so the final README's "Design decisions & tradeoffs"
section is grounded in real choices, not reconstructed after the fact. Not a deliverable on
its own — folds into README.md at P7.

## Decisions & tradeoffs

### Dedupe returns the existing item *regardless of status*
`POST /feedback` hashes the (validated, trimmed) content and, on a hash hit, returns the
existing record instead of inserting + re-analyzing. This includes items that previously
ended in `FAILED`.

- **Why:** idempotent submission, avoids redundant LLM spend, and the UNIQUE index doubles
  as a DB-enforced race backstop (rubric explicitly grades data/state consistency).
- **Consequence:** resubmitting content that failed will *not* start a fresh analysis — the
  caller gets the old `FAILED` record back. Re-driving a failed item is the job of
  `POST /feedback/:id/retry`, not resubmission. The POST response returns the existing
  `status`, so a dedupe hit on a failed/done item is visible to the caller rather than
  masquerading as a fresh `RECEIVED`.
- **Alternative considered:** re-analyze on resubmit if the prior attempt failed. Rejected:
  reintroduces the duplicate-work the guardrail exists to prevent, and muddies idempotency.

### Hash the validated content, not the raw body
The create DTO trims `content`, so the stored value is trimmed. The dedupe hash is computed
over that same trimmed value via the single `hashContent()` helper (colocated with the repo).
Hashing the raw body instead would let `"hi "` and `"hi"` diverge in hash while persisting
identical content. One canonical helper means the route and repository can't disagree.

### Zod is the enforcement boundary; `json_schema` is a best-effort nudge (P3)
The plan forces structured output via `response_format: { type: 'json_schema', strict: true }`
derived from the Zod model. Reality check for the implementation:

- OpenAI **strict** mode supports only a subset of JSON Schema. It requires every property in
  `required` + `additionalProperties: false`, and it **ignores / rejects** numeric
  `minimum`/`maximum` and string `minLength`. So our most interesting constraints —
  `confidence ∈ [0,1]` and non-empty `actionable_insight` — are **not** enforced by the model
  layer. Only the Zod re-validation enforces them.
- A strictly-validating backend can return **400 ("unsupported keyword")** when the generated
  schema carries `minimum/maximum/minLength`. P3 must strip unsupported keywords from the
  generated schema (structural-only schema to the model; Zod does bounds-checking), and treat
  such a 400 as a *config* error, not a per-item `FAILED`.
- Local models (Ollama/llama.cpp) often ignore the schema or wrap JSON in prose; `.strict()`
  correctly turns those into `FAILED`.

**Framing for the writeup:** "We re-validate every model response with Zod regardless of what
the backend claims to enforce; the JSON Schema is a nudge, not a guarantee." This is the honest
and defensible story and a strong AI-integration talking point (defense in depth).

### Compare-and-swap `setStatus` — what it actually buys
`setStatus(id, to, from?)` does a guarded `UPDATE ... WHERE status IN (...)`. better-sqlite3 is
synchronous, and the queue hands each id to a single worker, so this is **not** primarily about
steady-state contention. Its real value is the **boot recovery** path (`recoverStuck` re-enqueues
`ANALYZING` rows) and the **`/retry`** path, where a re-enqueue could otherwise race a late
worker. Describe it as defense-in-depth + correct recovery, not as solving a race the queue
already prevents.

### P2 — LLM client does transport only; the worker owns validation
The `LLMClient` interface returns `{ raw, json }` and does **no** schema checking. It throws
only for retryable *infrastructure* failures (`TransientLLMError`); a malformed/non-JSON/
wrong-shape body is a normal return. The worker then re-validates `json` with Zod. This split
is what lets one code path map two distinct failure kinds onto different terminal states:
- transient (thrown) → (P4) bounded auto-retry, else `FAILED`;
- schema-invalid (returned) → `FAILED` immediately, raw persisted (no token-burn re-prompt).

It also keeps "is transport working?" separate from "did the model produce a valid analysis?",
and means the P3 real client only has to do HTTP + `JSON.parse` — the defensive layer is shared.

### P2 — deterministic fake with failure-injection sentinels
The fake derives sentiment/feature-requests from keyword heuristics (plausible, schema-valid,
**reproducible**), and recognizes double-underscore sentinels to drive each defensive branch on
demand: `__FAIL_PARSE__` (non-JSON), `__FAIL_SCHEMA__` (bad enum + out-of-range confidence +
empty insight), `__FAIL_TRANSIENT__` (throws). This is why every state-machine edge is covered
by an offline test, and the demo can show a real `FAILED` row without depending on a flaky model.

### P2 — queue: self-rescheduling pump, drop-pending-on-stop
The in-process queue is a ~40-line pump: each finished task frees a slot and re-pumps, so up to
`WORKER_CONCURRENCY` run at once with no timers/polling. It is generic over `process` — it knows
nothing about feedback or the DB, keeping the entire state machine in the worker. `stop()` stops
accepting work and awaits **in-flight** tasks (graceful drain via Fastify `onClose`); **pending**
items are intentionally dropped — the in-process queue is not durable.
A last-resort `.catch` in the pump guards against an unexpected worker throw wedging the queue,
even though the worker is written to swallow its own failures into `FAILED` rows.

> **Boot-recovery must cover RECEIVED, not just ANALYZING (note for P5).** A dropped pending
> item is still `RECEIVED` in the DB — it was never marked `ANALYZING`. So `recoverStuck()`
> (which only resets `ANALYZING -> RECEIVED`) would *not* re-enqueue it, leaving it orphaned
> in `RECEIVED` forever. P5 recovery must therefore **enqueue every non-terminal row**
> (`RECEIVED` ∪ the rows it just reset from `ANALYZING`), not only the ones it reset. With
> that, "dropped on shutdown" is genuinely recovered on next boot; without it, the in-process
> queue silently loses un-started work.

### P2 — terminal write + status transition are atomic
The last step of the state machine — persist the `analyses` row **and** flip out of `ANALYZING`
— runs in a single transaction (`repo.finishAttempt`, a guarded CAS + insert). Two separate
statements would let a crash land *between* them: an analysis row written while the item is
still `ANALYZING`, which boot recovery then re-runs — a duplicate analysis and wasted LLM spend.
Doing it atomically means an attempt is persisted iff the transition it belongs to committed.
The claim step (`RECEIVED -> ANALYZING`) stays a standalone CAS on purpose: it must precede the
async LLM call, and a DB transaction can't (and shouldn't) be held open across a network round-trip.

## Minor / accepted

- **`feature_requests` stored as JSON text:** not independently queryable by feature. Fine for
  scope; revisit with a child table if querying-by-feature ever matters.
- **`listWithAnalysis` does N+1 latest-analysis lookups:** bounded by `limit`, acceptable. A
  windowed join would remove it if needed.
- **Schema ↔ config coupling at import:** `schemas/feedback.ts` reads `config.maxContentLength`
  at module load, so importing it triggers env validation. Fine for the app; a factory would
  decouple it for isolated unit tests. Left as-is for the timebox.
- **WAL pragma is a no-op on `:memory:`** (tests) — harmless.
- **Status `CHECK` constraint duplicates the Zod enum** — intentional belt-and-suspenders across
  the API and DB boundaries.

## What I'd improve with more time (collaboration-log seed)
- Durable queue (persist/poll the DB or a broker) instead of in-process — survives crashes
  beyond the boot-recovery mitigation.
- One stricter reprompt on schema-invalid output before giving up (currently fail-fast to avoid
  token-burn loops).
- Normalized `feature_requests` table for query-by-feature.
- Richer observability (per-state metrics, attempt histograms).
