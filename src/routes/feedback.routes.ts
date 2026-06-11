import type { FastifyInstance } from 'fastify';
import type { AnalysisQueue } from '../queue/queue';
import type { FeedbackRepo } from '../repositories/feedback.repo';
import { hashContent } from '../repositories/feedback.repo';
import {
  CreateFeedbackSchema,
  FeedbackIdParamSchema,
  ListFeedbackQuerySchema,
} from '../schemas/feedback';

export interface FeedbackRoutesOptions {
  repo: FeedbackRepo;
  queue: AnalysisQueue;
}

/** SQLite UNIQUE-constraint violation, as raised by better-sqlite3 on a duplicate hash. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Feedback ingest + read endpoints.
 *
 * Validation is Zod (the same schemas used everywhere) so the API boundary rejects
 * empty/over-length/extra-field input before anything is persisted or sent to the LLM.
 *  - POST /feedback         ingest, dedupe by content hash, enqueue
 *  - GET  /feedback         list with status filter + pagination
 *  - GET  /feedback/:id     single item + latest analysis
 *  - POST /feedback/:id/retry  re-enqueue a FAILED item
 */
export async function feedbackRoutes(
  app: FastifyInstance,
  opts: FeedbackRoutesOptions,
): Promise<void> {
  const { repo, queue } = opts;

  // POST /feedback — validate, dedupe by hash, persist RECEIVED, enqueue, return 202.
  app.post('/feedback', async (request, reply) => {
    const parsed = CreateFeedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const { content } = parsed.data;
    const contentHash = hashContent(content);

    // Dedupe guardrail: identical content is idempotent. Return the existing item instead of
    // creating a duplicate row and re-spending on the LLM. 200 (not 202) signals "already
    // known" — no new work was enqueued.
    const existing = repo.findByHash(contentHash);
    if (existing) {
      return reply.code(200).send({ id: existing.id, status: existing.status, deduplicated: true });
    }

    let feedback;
    try {
      feedback = repo.create({ content, contentHash });
    } catch (err) {
      // Race backstop: a concurrent identical submit won the UNIQUE index between our lookup
      // and insert. Treat it exactly like the dedupe hit above rather than 500.
      if (isUniqueViolation(err)) {
        const raced = repo.findByHash(contentHash);
        if (raced) {
          return reply.code(200).send({ id: raced.id, status: raced.status, deduplicated: true });
        }
      }
      throw err;
    }

    queue.enqueue(feedback.id);
    // 202 Accepted: the work is queued, not done. The caller polls GET /feedback/:id.
    return reply.code(202).send({ id: feedback.id, status: feedback.status });
  });

  // GET /feedback — list with optional ?status= filter and ?limit=&offset= pagination.
  app.get('/feedback', async (request, reply) => {
    const parsed = ListFeedbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const { status, limit, offset } = parsed.data;
    const items = repo.listWithAnalysis({ status, limit, offset });
    return { items, limit, offset };
  });

  // GET /feedback/:id — current status + latest analysis (null until analysis completes).
  app.get('/feedback/:id', async (request, reply) => {
    const parsed = FeedbackIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError' });
    }

    const item = repo.getWithAnalysis(parsed.data.id);
    if (!item) {
      return reply.code(404).send({ error: 'NotFound' });
    }
    return item;
  });

  // POST /feedback/:id/retry — re-enqueue a FAILED item. 404 if missing, 409 if not FAILED.
  app.post('/feedback/:id/retry', async (request, reply) => {
    const parsed = FeedbackIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError' });
    }

    const item = repo.findById(parsed.data.id);
    if (!item) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    // Guarded CAS FAILED -> RECEIVED. Only a FAILED item is retriable; the CAS also closes the
    // race where two concurrent retries arrive at once (only the first transition wins).
    const requeued = repo.setStatus(item.id, 'RECEIVED', 'FAILED');
    if (!requeued) {
      return reply.code(409).send({
        error: 'Conflict',
        message: `feedback is ${item.status}, only FAILED items can be retried`,
      });
    }

    queue.enqueue(item.id);
    return reply.code(202).send({ id: item.id, status: 'RECEIVED' });
  });
}
