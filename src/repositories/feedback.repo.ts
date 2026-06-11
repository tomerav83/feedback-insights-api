import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import type { AnalysisRecord, FeatureRequest, Sentiment } from '../schemas/analysis';
import type {
  FeedbackRecord,
  FeedbackStatus,
  FeedbackWithAnalysis,
} from '../schemas/feedback';

/** Raw column shapes as stored in SQLite (decoded into the domain types below). */
interface FeedbackRow {
  id: string;
  content: string;
  content_hash: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
}

interface AnalysisRow {
  id: string;
  feedback_id: string;
  attempt: number;
  raw_response: string | null;
  sentiment: string | null;
  feature_requests: string | null;
  actionable_insight: string | null;
  valid: number;
  error: string | null;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Canonical dedupe key. The single source of truth for how feedback content maps to its
 * `content_hash`, so the route and the repository can never disagree.
 *
 * IMPORTANT: pass the *validated* content — i.e. the value after `CreateFeedbackSchema`
 * has trimmed it — not the raw request body. Hashing the raw body would let "hi " and
 * "hi" hash differently while persisting identical content, breaking dedupe and making
 * the stored hash irreproducible from the stored row.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function mapFeedback(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    content: row.content,
    contentHash: row.content_hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAnalysis(row: AnalysisRow): AnalysisRecord {
  return {
    id: row.id,
    feedbackId: row.feedback_id,
    attempt: row.attempt,
    rawResponse: row.raw_response,
    // feature_requests was validated before it was written, so we trust the stored JSON.
    sentiment: row.sentiment as Sentiment | null,
    featureRequests: row.feature_requests
      ? (JSON.parse(row.feature_requests) as FeatureRequest[])
      : null,
    actionableInsight: row.actionable_insight,
    valid: row.valid !== 0,
    error: row.error,
    createdAt: row.created_at,
  };
}

export interface InsertAnalysisInput {
  feedbackId: string;
  attempt: number;
  rawResponse: string | null;
  sentiment: Sentiment | null;
  featureRequests: FeatureRequest[] | null;
  actionableInsight: string | null;
  valid: boolean;
  error: string | null;
}

export interface FeedbackRepo {
  create(input: { content: string; contentHash: string }): FeedbackRecord;
  findById(id: string): FeedbackRecord | undefined;
  findByHash(contentHash: string): FeedbackRecord | undefined;
  list(opts: { status?: FeedbackStatus; limit: number; offset: number }): FeedbackRecord[];
  /**
   * Compare-and-swap status update. When `from` is given, the row only changes if it is
   * currently in one of those states — the primitive the worker uses to claim an item
   * (RECEIVED -> ANALYZING) without racing a second worker. Returns true if a row changed.
   */
  setStatus(id: string, to: FeedbackStatus, from?: FeedbackStatus | FeedbackStatus[]): boolean;
  /** Crash recovery: reset any item stuck in ANALYZING back to RECEIVED. Returns their ids. */
  recoverStuck(): string[];
  insertAnalysis(input: InsertAnalysisInput): AnalysisRecord;
  nextAttempt(feedbackId: string): number;
  latestAnalysis(feedbackId: string): AnalysisRecord | undefined;
  getWithAnalysis(id: string): FeedbackWithAnalysis | undefined;
  listWithAnalysis(opts: {
    status?: FeedbackStatus;
    limit: number;
    offset: number;
  }): FeedbackWithAnalysis[];
}

/**
 * The persistence boundary. Everything that touches SQL lives here, so swapping the
 * storage engine (e.g. for an ORM or a hosted DB) is a single-file change. A factory
 * over a `Db` handle keeps it testable: the app passes the configured singleton, tests
 * pass an in-memory database.
 */
export function createFeedbackRepo(db: Db): FeedbackRepo {
  const insertFeedback = db.prepare<[string, string, string, string, string, string]>(
    `INSERT INTO feedback (id, content, content_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectById = db.prepare(`SELECT * FROM feedback WHERE id = ?`);
  const selectByHash = db.prepare(`SELECT * FROM feedback WHERE content_hash = ?`);
  const setStatusUnconditional = db.prepare<[FeedbackStatus, string, string]>(
    `UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?`,
  );
  const recoverStmt = db.prepare<[string]>(
    `UPDATE feedback SET status = 'RECEIVED', updated_at = ?
     WHERE status = 'ANALYZING' RETURNING id`,
  );

  const insertAnalysisStmt = db.prepare<
    [string, string, number, string | null, string | null, string | null, string | null, number, string | null, string]
  >(
    `INSERT INTO analyses
       (id, feedback_id, attempt, raw_response, sentiment, feature_requests,
        actionable_insight, valid, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nextAttemptStmt = db.prepare<[string]>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM analyses WHERE feedback_id = ?`,
  );
  const latestAnalysisStmt = db.prepare<[string]>(
    `SELECT * FROM analyses WHERE feedback_id = ?
     ORDER BY attempt DESC, created_at DESC LIMIT 1`,
  );

  return {
    create({ content, contentHash }) {
      const id = randomUUID();
      const ts = nowIso();
      insertFeedback.run(id, content, contentHash, 'RECEIVED', ts, ts);
      return {
        id,
        content,
        contentHash,
        status: 'RECEIVED',
        createdAt: ts,
        updatedAt: ts,
      };
    },

    findById(id) {
      const row = selectById.get(id) as FeedbackRow | undefined;
      return row ? mapFeedback(row) : undefined;
    },

    findByHash(contentHash) {
      const row = selectByHash.get(contentHash) as FeedbackRow | undefined;
      return row ? mapFeedback(row) : undefined;
    },

    list({ status, limit, offset }) {
      // Status is a validated enum and limit/offset are numbers, but they are still bound
      // as parameters; only the optional WHERE clause is assembled conditionally.
      const where = status ? `WHERE status = @status` : '';
      const rows = db
        .prepare(
          `SELECT * FROM feedback ${where}
           ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`,
        )
        .all({ status, limit, offset }) as FeedbackRow[];
      return rows.map(mapFeedback);
    },

    setStatus(id, to, from) {
      if (from === undefined) {
        return setStatusUnconditional.run(to, nowIso(), id).changes > 0;
      }
      const froms = Array.isArray(from) ? from : [from];
      const placeholders = froms.map(() => '?').join(', ');
      const info = db
        .prepare(
          `UPDATE feedback SET status = ?, updated_at = ?
           WHERE id = ? AND status IN (${placeholders})`,
        )
        .run(to, nowIso(), id, ...froms);
      return info.changes > 0;
    },

    recoverStuck() {
      const rows = recoverStmt.all(nowIso()) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },

    insertAnalysis(input) {
      const id = randomUUID();
      const ts = nowIso();
      const featureRequestsJson =
        input.featureRequests === null ? null : JSON.stringify(input.featureRequests);
      insertAnalysisStmt.run(
        id,
        input.feedbackId,
        input.attempt,
        input.rawResponse,
        input.sentiment,
        featureRequestsJson,
        input.actionableInsight,
        input.valid ? 1 : 0,
        input.error,
        ts,
      );
      return {
        id,
        feedbackId: input.feedbackId,
        attempt: input.attempt,
        rawResponse: input.rawResponse,
        sentiment: input.sentiment,
        featureRequests: input.featureRequests,
        actionableInsight: input.actionableInsight,
        valid: input.valid,
        error: input.error,
        createdAt: ts,
      };
    },

    nextAttempt(feedbackId) {
      const row = nextAttemptStmt.get(feedbackId) as { n: number };
      return row.n;
    },

    latestAnalysis(feedbackId) {
      const row = latestAnalysisStmt.get(feedbackId) as AnalysisRow | undefined;
      return row ? mapAnalysis(row) : undefined;
    },

    getWithAnalysis(id) {
      const feedback = this.findById(id);
      if (!feedback) return undefined;
      return { ...feedback, analysis: this.latestAnalysis(id) ?? null };
    },

    listWithAnalysis(opts) {
      // N+1 latest-analysis lookups: acceptable at this scale and bounded by `limit`.
      return this.list(opts).map((feedback) => ({
        ...feedback,
        analysis: this.latestAnalysis(feedback.id) ?? null,
      }));
    },
  };
}
