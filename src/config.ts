import 'dotenv/config';
import { z } from 'zod';

/**
 * Single choke point for reading process.env.
 * Fail-fast on bad config. The LLM backend is provider-agnostic (any OpenAI-compatible
 * endpoint): set LLM_BASE_URL to go live, leave it unset for the deterministic offline
 * fake. LLM_API_KEY (only needed for hosted backends; local Ollama needs none) is read
 * here exactly once and is never logged or reflected over the API (see /health, which
 * returns only a live|fake boolean derived from whether a backend is configured).
 */
// An empty env value (e.g. `LLM_BASE_URL=` straight from .env.example) means "unset",
// not "the empty string" — so the zero-setup fake-LLM default works on a fresh copy
// instead of failing .url()/.min(1) validation.
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const EnvSchema = z.object({
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).default('llama3.1')),
  LLM_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().min(1).default('./data.db'),
  MAX_CONTENT_LENGTH: z.coerce.number().int().positive().default(8000),
  MAX_AUTO_RETRIES: z.coerce.number().int().min(0).default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Print field errors (keys only, never values) and exit before anything boots.
  console.error('Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  dbPath: env.DB_PATH,
  maxContentLength: env.MAX_CONTENT_LENGTH,
  maxAutoRetries: env.MAX_AUTO_RETRIES,
  workerConcurrency: env.WORKER_CONCURRENCY,
  llm: {
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    // OpenAI-compatible servers require *some* key string even when auth is unused
    // (e.g. local Ollama): default to a placeholder so the client constructs cleanly.
    apiKey: env.LLM_API_KEY ?? 'not-needed',
  },
  /** 'live' when an LLM backend is configured, else the deterministic offline fake. */
  llmMode: (env.LLM_BASE_URL ? 'live' : 'fake') as 'live' | 'fake',
} as const;

export type Config = typeof config;
