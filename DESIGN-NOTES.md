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
