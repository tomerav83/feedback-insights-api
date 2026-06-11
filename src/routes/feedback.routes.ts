import type { FastifyInstance } from 'fastify';
import type { AnalysisQueue } from '../queue/queue';
import type { FeedbackRepo } from '../repositories/feedback.repo';
import { hashContent } from '../repositories/feedback.repo';
import {
  CreateFeedbackSchema,
  FeedbackIdParamSchema,
} from '../schemas/feedback';

export interface FeedbackRoutesOptions {
  repo: FeedbackRepo;
  queue: AnalysisQueue;
}

/**
 * Feedback ingest + read endpoints.
 *
 * P2 scope (the vertical slice): POST to ingest + enqueue, GET /:id to observe the item
 * move through the state machine. Validation is Zod (the same schemas used everywhere) so
 * the API boundary rejects empty/over-length/extra-field input before anything is persisted
 * or sent to the LLM. Dedupe (P4) and list/filter/pagination + /retry (P4/P5) land later.
 */
export async function feedbackRoutes(
  app: FastifyInstance,
  opts: FeedbackRoutesOptions,
): Promise<void> {
  const { repo, queue } = opts;

  // POST /feedback — validate, persist RECEIVED, enqueue for async analysis, return 202.
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
    const feedback = repo.create({ content, contentHash: hashContent(content) });
    queue.enqueue(feedback.id);

    // 202 Accepted: the work is queued, not done. The caller polls GET /feedback/:id.
    return reply.code(202).send({ id: feedback.id, status: feedback.status });
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
}
