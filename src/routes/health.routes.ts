import type { FastifyInstance } from 'fastify';
import { config } from '../config';

/**
 * GET /health -> { status, llm }
 * Reports whether a live OpenAI-compatible backend or the deterministic fake is wired.
 * Never reveals the key/endpoint — only a 'live' | 'fake' flag.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok', llm: config.llmMode };
  });
}
