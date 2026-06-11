import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config';
import { db as defaultDb, type Db } from './db/client';
import { migrate } from './db/migrate';
import { createLLMClient } from './llm/factory';
import type { LLMClient } from './llm/types';
import { createQueue } from './queue/queue';
import { createFeedbackRepo } from './repositories/feedback.repo';
import { feedbackRoutes } from './routes/feedback.routes';
import { healthRoutes } from './routes/health.routes';
import { createAnalyzer } from './worker/analyze';

/**
 * Injectable dependencies. The app wires the configured singleton DB + the factory-selected
 * LLM client; tests pass an in-memory DB and the fake to get full isolation with no files
 * and no network.
 */
export interface ServerDeps {
  db?: Db;
  llm?: LLMClient;
}

/**
 * Builds the Fastify app and wires the full pipeline: DB -> repository -> worker -> queue ->
 * routes. Kept free of `listen`/signal handling (that is index.ts) so it can be driven
 * directly in tests via `app.inject`.
 *
 * The worker starts as soon as the app is built and is drained on `onClose`, so Fastify's
 * lifecycle gives us graceful shutdown for free: app.close() stops accepting requests, then
 * runs this hook to let in-flight analyses settle.
 */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Defensive redaction: the key must never reach the logs even by accident.
      redact: ['req.headers.authorization', '*.apiKey', '*.llm.apiKey'],
    },
  });

  const db = deps.db ?? defaultDb;
  migrate(db); // idempotent (CREATE TABLE IF NOT EXISTS) — safe to run on every build.

  const repo = createFeedbackRepo(db);
  const llm = deps.llm ?? createLLMClient();
  const analyze = createAnalyzer({ repo, llm, logger: app.log });
  const queue = createQueue({
    concurrency: config.workerConcurrency,
    process: analyze,
    logger: app.log,
  });
  queue.start();

  app.register(healthRoutes);
  app.register(feedbackRoutes, { repo, queue });

  // Drain in-flight analyses before the process exits.
  app.addHook('onClose', async () => {
    await queue.stop();
  });

  return app;
}
