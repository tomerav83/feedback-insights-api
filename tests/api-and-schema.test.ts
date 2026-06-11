/**
 * P6 boundary/contract tests — the high-value gaps that complement the existing
 * state-machine tests (vertical-slice / guardrail-retry / llm-openai-compatible).
 *
 * Two layers:
 *  - AIAnalysisSchema as a pure contract (safeParse) — the heart of the exercise.
 *  - The HTTP boundary (buildServer + app.inject): input validation, 404/health,
 *    and the trim-then-hash dedupe invariant.
 *
 * These deliberately do NOT re-test the worker state machine, retry budget, or the
 * openai-compatible client, which are already covered elsewhere.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { openDatabase } from '../src/db/client';
import { createFakeLLMClient } from '../src/llm/fake';
import { createFeedbackRepo } from '../src/repositories/feedback.repo';
import type { FeedbackRepo } from '../src/repositories/feedback.repo';
import { AIAnalysisSchema } from '../src/schemas/analysis';
import type { FeedbackStatus } from '../src/schemas/feedback';
import { buildServer } from '../src/server';

const TERMINAL: FeedbackStatus[] = ['DONE', 'FAILED'];

/** Poll until the item reaches a terminal state (the worker runs async). */
async function waitForTerminal(repo: FeedbackRepo, id: string, timeoutMs = 1000): Promise<FeedbackStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const item = repo.findById(id);
    if (item && TERMINAL.includes(item.status)) return item.status;
    if (Date.now() > deadline) throw new Error(`timed out waiting for terminal state of ${id}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('AIAnalysisSchema contract', () => {
  const valid = {
    sentiment: 'positive',
    feature_requests: [{ title: 'dark mode', confidence: 0.8 }],
    actionable_insight: 'Ship a dark theme.',
  };

  it('accepts a fully valid analysis', () => {
    expect(AIAnalysisSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an empty feature_requests array', () => {
    expect(AIAnalysisSchema.safeParse({ ...valid, feature_requests: [] }).success).toBe(true);
  });

  it('accepts confidence at the 0 and 1 boundaries', () => {
    expect(
      AIAnalysisSchema.safeParse({
        ...valid,
        feature_requests: [
          { title: 'a', confidence: 0 },
          { title: 'b', confidence: 1 },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a sentiment outside the enum', () => {
    expect(AIAnalysisSchema.safeParse({ ...valid, sentiment: 'ecstatic' }).success).toBe(false);
  });

  it('rejects confidence > 1', () => {
    expect(
      AIAnalysisSchema.safeParse({ ...valid, feature_requests: [{ title: 'x', confidence: 1.5 }] }).success,
    ).toBe(false);
  });

  it('rejects confidence < 0', () => {
    expect(
      AIAnalysisSchema.safeParse({ ...valid, feature_requests: [{ title: 'x', confidence: -0.1 }] }).success,
    ).toBe(false);
  });

  it('rejects a feature_request missing its title', () => {
    expect(
      AIAnalysisSchema.safeParse({ ...valid, feature_requests: [{ confidence: 0.5 }] }).success,
    ).toBe(false);
  });

  it('rejects an empty feature_request title', () => {
    expect(
      AIAnalysisSchema.safeParse({ ...valid, feature_requests: [{ title: '', confidence: 0.5 }] }).success,
    ).toBe(false);
  });

  it('rejects an empty actionable_insight', () => {
    expect(AIAnalysisSchema.safeParse({ ...valid, actionable_insight: '' }).success).toBe(false);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    expect(AIAnalysisSchema.safeParse({ ...valid, severity: 'high' }).success).toBe(false);
  });

  it('rejects an unknown key inside a feature_request (.strict)', () => {
    expect(
      AIAnalysisSchema.safeParse({
        ...valid,
        feature_requests: [{ title: 'x', confidence: 0.5, votes: 3 }],
      }).success,
    ).toBe(false);
  });

  it('rejects non-object / wrong-typed input', () => {
    expect(AIAnalysisSchema.safeParse('not an object').success).toBe(false);
    expect(AIAnalysisSchema.safeParse(null).success).toBe(false);
    expect(AIAnalysisSchema.safeParse({ ...valid, sentiment: 42 }).success).toBe(false);
  });
});

describe('POST /feedback input-boundary validation', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function freshApp() {
    app = buildServer({ db: openDatabase(':memory:'), llm: createFakeLLMClient() });
    return app;
  }

  it('rejects empty content with 400 ValidationError', async () => {
    const res = await freshApp().inject({ method: 'POST', url: '/feedback', payload: { content: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('rejects whitespace-only content with 400 ValidationError', async () => {
    const res = await freshApp().inject({ method: 'POST', url: '/feedback', payload: { content: '   \n\t ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('rejects content over MAX_CONTENT_LENGTH with 400', async () => {
    const tooLong = 'a'.repeat(8001);
    const res = await freshApp().inject({ method: 'POST', url: '/feedback', payload: { content: tooLong } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('rejects an unknown body field with 400 (.strict)', async () => {
    const res = await freshApp().inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'valid content', priority: 'high' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('rejects a missing content field with 400', async () => {
    const res = await freshApp().inject({ method: 'POST', url: '/feedback', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('accepts a valid post with 202 and status RECEIVED', async () => {
    const res = await freshApp().inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'A genuinely useful piece of feedback.' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ id: string; status: string }>();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe('RECEIVED');
  });
});

describe('GET /feedback/:id', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 404 NotFound for an unknown id', async () => {
    app = buildServer({ db: openDatabase(':memory:'), llm: createFakeLLMClient() });
    const res = await app.inject({ method: 'GET', url: '/feedback/nope-not-real' });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('NotFound');
  });

  it('returns the item with its analysis once it reaches a terminal state', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });
    const repo = createFeedbackRepo(db);

    const post = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'Please add CSV export, it would be great.' },
    });
    const { id } = post.json<{ id: string }>();

    expect(await waitForTerminal(repo, id)).toBe('DONE');

    const get = await app.inject({ method: 'GET', url: `/feedback/${id}` });
    expect(get.statusCode).toBe(200);
    const body = get.json<{ id: string; status: string; analysis: { valid: boolean; sentiment: string } | null }>();
    expect(body.id).toBe(id);
    expect(body.status).toBe('DONE');
    expect(body.analysis?.valid).toBe(true);
    expect(body.analysis?.sentiment).toBe('positive');
  });
});

describe('GET /health', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports ok and the configured LLM mode without leaking endpoint/key', async () => {
    // /health derives its `llm` flag from config.llmMode (live|fake), never the injected
    // client, and never reveals the key/endpoint — only the boolean-ish mode flag.
    app = buildServer({ db: openDatabase(':memory:'), llm: createFakeLLMClient() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', llm: config.llmMode });
  });
});

describe('dedupe is computed over trimmed content', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('treats whitespace-padded content as a duplicate of the trimmed original', async () => {
    app = buildServer({ db: openDatabase(':memory:'), llm: createFakeLLMClient() });

    const first = await app.inject({ method: 'POST', url: '/feedback', payload: { content: 'hello world' } });
    expect(first.statusCode).toBe(202);
    const firstId = first.json<{ id: string }>().id;

    // Leading/trailing whitespace is trimmed by CreateFeedbackSchema before hashContent,
    // so this hashes to the same key and must dedupe to the same row.
    const second = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: '  hello world  ' },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json<{ id: string; deduplicated: boolean }>();
    expect(body.deduplicated).toBe(true);
    expect(body.id).toBe(firstId);
  });
});
