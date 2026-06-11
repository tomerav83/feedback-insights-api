import type { Db } from './client';

/**
 * Idempotent schema creation, run on boot. No migration tooling (out of scope for a 3h
 * box) — `IF NOT EXISTS` is enough since the schema only ever grows during this exercise.
 *
 * Data model notes:
 *  - feedback.content_hash has a UNIQUE index: it is the dedupe guardrail (sha256 of the
 *    content) AND a race backstop against concurrent identical submits, enforced by the DB
 *    rather than application code alone.
 *  - analyses keeps one row per attempt (preserving retry history); the structured result
 *    is stored as JSON text in feature_requests — accepted tradeoff: not independently
 *    queryable by feature, fine for this scope.
 */
export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           TEXT PRIMARY KEY,
      content      TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      status       TEXT NOT NULL CHECK (status IN ('RECEIVED','ANALYZING','DONE','FAILED')),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id                 TEXT PRIMARY KEY,
      feedback_id        TEXT NOT NULL REFERENCES feedback(id),
      attempt            INTEGER NOT NULL,
      raw_response       TEXT,
      sentiment          TEXT,
      feature_requests   TEXT,
      actionable_insight TEXT,
      valid              INTEGER NOT NULL CHECK (valid IN (0,1)),
      error              TEXT,
      created_at         TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
    CREATE INDEX IF NOT EXISTS idx_analyses_feedback ON analyses(feedback_id, attempt);
  `);
}
