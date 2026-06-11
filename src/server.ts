import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health.routes';

/**
 * Builds the Fastify app and registers routes. Kept free of side effects
 * (no listen, no process signals) so it can be exercised directly in tests.
 * Later portions register the worker lifecycle here via app.addHook('onClose').
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Defensive redaction: the key must never reach the logs even by accident.
      redact: ['req.headers.authorization', '*.apiKey', '*.llm.apiKey'],
    },
  });

  app.register(healthRoutes);

  return app;
}
