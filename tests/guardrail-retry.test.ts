import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { createFakeLLMClient } from '../src/llm/fake';
import type { LLMAnalysisResult, LLMClient } from '../src/llm/types';
import { TransientLLMError } from '../src/llm/types';
import { createFeedbackRepo, hashContent } from '../src/repositories/feedback.repo';
import type { FeedbackRepo } from '../src/repositories/feedback.repo';
import type { FeedbackStatus } from '../src/schemas/feedback';
import { createAnalyzer } from '../src/worker/analyze';
import { buildServer } from '../src/server';

const TERMINAL: FeedbackStatus[] = ['DONE', 'FAILED'];

async function waitForTerminal(repo: FeedbackRepo, id: string, timeoutMs = 1000): Promise<FeedbackStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const item = repo.findById(id);
    if (item && TERMINAL.includes(item.status)) return item.status;
    if (Date.now() > deadline) throw new Error(`timed out waiting for terminal state of ${id}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A valid, schema-compliant analysis payload the fake/stub clients can return. */
function validResult(): LLMAnalysisResult {
  const analysis = { sentiment: 'neutral', feature_requests: [], actionable_insight: 'ok' };
  return { raw: JSON.stringify(analysis), json: analysis };
}

/** LLM stub that throws TransientLLMError `failures` times, then returns a valid result. */
function flakyLLM(failures: number): LLMClient {
  let calls = 0;
  return {
    mode: 'fake',
    async analyze(): Promise<LLMAnalysisResult> {
      if (calls++ < failures) throw new TransientLLMError('flaky infra');
      return validResult();
    },
  };
}

describe('worker auto-retry on transient errors', () => {
  it('retries within budget and ends DONE once the LLM recovers', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);
    const analyze = createAnalyzer({
      repo,
      llm: flakyLLM(2), // fails twice, succeeds on the 3rd try
      maxAutoRetries: 2,
      sleep: async () => {},
    });

    const fb = repo.create({ content: 'flaky path', contentHash: hashContent('flaky path') });
    await analyze(fb.id);

    expect(repo.findById(fb.id)?.status).toBe('DONE');
    // Only the terminal outcome is persisted — one analysis row, not one per transient try.
    expect(repo.latestAnalysis(fb.id)?.attempt).toBe(1);
    expect(repo.latestAnalysis(fb.id)?.valid).toBe(true);
  });

  it('exhausts the retry budget and ends FAILED, recording the attempt count', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);
    const analyze = createAnalyzer({
      repo,
      llm: flakyLLM(5), // never recovers within budget
      maxAutoRetries: 2,
      sleep: async () => {},
    });

    const fb = repo.create({ content: 'always flaky', contentHash: hashContent('always flaky') });
    await analyze(fb.id);

    expect(repo.findById(fb.id)?.status).toBe('FAILED');
    expect(repo.latestAnalysis(fb.id)?.error).toMatch(/transient LLM error after 3 attempt/);
  });
});

describe('dedupe + /retry endpoints', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('POST with identical content dedupes: second call returns 200 + same id, no new row', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });
    const payload = { content: 'duplicate me exactly' };

    const first = await app.inject({ method: 'POST', url: '/feedback', payload });
    expect(first.statusCode).toBe(202);
    const firstId = first.json<{ id: string }>().id;

    const second = await app.inject({ method: 'POST', url: '/feedback', payload });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ id: string; deduplicated: boolean }>();
    expect(secondBody.id).toBe(firstId);
    expect(secondBody.deduplicated).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/feedback' });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('POST /feedback/:id/retry: FAILED -> 202 RECEIVED and re-processed', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });
    const repo = createFeedbackRepo(db);

    // Drive it to FAILED via the schema-failure sentinel.
    const post = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'please __FAIL_SCHEMA__ now' },
    });
    const id = post.json<{ id: string }>().id;
    expect(await waitForTerminal(repo, id)).toBe('FAILED');

    const retry = await app.inject({ method: 'POST', url: `/feedback/${id}/retry` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json<{ status: string }>().status).toBe('RECEIVED');

    // It runs again (still the same failing content) -> FAILED, now a 2nd attempt row.
    expect(await waitForTerminal(repo, id)).toBe('FAILED');
    expect(repo.latestAnalysis(id)?.attempt).toBe(2);
  });

  it('POST /feedback/:id/retry: non-FAILED item -> 409', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });
    const repo = createFeedbackRepo(db);

    const post = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'a happy successful path' },
    });
    const id = post.json<{ id: string }>().id;
    expect(await waitForTerminal(repo, id)).toBe('DONE');

    const retry = await app.inject({ method: 'POST', url: `/feedback/${id}/retry` });
    expect(retry.statusCode).toBe(409);
  });

  it('POST /feedback/:id/retry: unknown id -> 404', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });

    const retry = await app.inject({ method: 'POST', url: '/feedback/nope/retry' });
    expect(retry.statusCode).toBe(404);
  });
});

describe('list endpoint: filter + pagination', () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('lists items, filters by status, and bounds with limit/offset', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });
    const repo = createFeedbackRepo(db);

    const ids: string[] = [];
    for (const content of ['first item love it', 'second item love it', 'third item love it']) {
      const post = await app.inject({ method: 'POST', url: '/feedback', payload: { content } });
      ids.push(post.json<{ id: string }>().id);
    }
    for (const id of ids) await waitForTerminal(repo, id);

    const all = await app.inject({ method: 'GET', url: '/feedback' });
    expect(all.json<{ items: unknown[] }>().items).toHaveLength(3);

    const done = await app.inject({ method: 'GET', url: '/feedback?status=DONE' });
    expect(done.json<{ items: unknown[] }>().items).toHaveLength(3);

    const failed = await app.inject({ method: 'GET', url: '/feedback?status=FAILED' });
    expect(failed.json<{ items: unknown[] }>().items).toHaveLength(0);

    const page = await app.inject({ method: 'GET', url: '/feedback?limit=2&offset=0' });
    const pageBody = page.json<{ items: unknown[]; limit: number; offset: number }>();
    expect(pageBody.items).toHaveLength(2);
    expect(pageBody.limit).toBe(2);

    const bad = await app.inject({ method: 'GET', url: '/feedback?status=BOGUS' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('stuck-ANALYZING recovery on boot', () => {
  it('resets a stranded ANALYZING item and re-processes it to terminal', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);

    // Simulate a crash mid-analysis: a row left stuck in ANALYZING.
    const fb = repo.create({ content: 'stranded mid-flight', contentHash: hashContent('stranded mid-flight') });
    repo.setStatus(fb.id, 'ANALYZING', 'RECEIVED');
    expect(repo.findById(fb.id)?.status).toBe('ANALYZING');

    // Booting a server on the same db must recover + finish it.
    const app = buildServer({ db, llm: createFakeLLMClient() });
    try {
      expect(await waitForTerminal(repo, fb.id)).toBe('DONE');
    } finally {
      await app.close();
    }
  });

  it('re-enqueues an orphaned RECEIVED item (dropped pending work) on boot', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);

    // Simulate work that was enqueued but dropped from the non-durable queue on shutdown:
    // a row left in RECEIVED that was never marked ANALYZING (so recoverStuck won't touch it).
    const fb = repo.create({ content: 'never started before restart', contentHash: hashContent('never started before restart') });
    expect(repo.findById(fb.id)?.status).toBe('RECEIVED');

    // Booting must enqueue all RECEIVED rows, not just the ones reset from ANALYZING.
    const app = buildServer({ db, llm: createFakeLLMClient() });
    try {
      expect(await waitForTerminal(repo, fb.id)).toBe('DONE');
    } finally {
      await app.close();
    }
  });
});
