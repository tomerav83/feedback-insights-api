import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { createFakeLLMClient } from '../src/llm/fake';
import { createQueue } from '../src/queue/queue';
import { createFeedbackRepo, hashContent } from '../src/repositories/feedback.repo';
import type { FeedbackRepo } from '../src/repositories/feedback.repo';
import type { FeedbackStatus } from '../src/schemas/feedback';
import { createAnalyzer } from '../src/worker/analyze';
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

/** A fresh in-memory pipeline (db + repo + queue against the fake) per test. */
function freshPipeline() {
  const db = openDatabase(':memory:');
  migrate(db);
  const repo = createFeedbackRepo(db);
  const analyze = createAnalyzer({ repo, llm: createFakeLLMClient() });
  const queue = createQueue({ concurrency: 2, process: analyze });
  queue.start();
  return { db, repo, queue };
}

function submit(repo: FeedbackRepo, queue: ReturnType<typeof freshPipeline>['queue'], content: string): string {
  const fb = repo.create({ content, contentHash: hashContent(content) });
  queue.enqueue(fb.id);
  return fb.id;
}

describe('vertical slice: queue + worker state machine (fake LLM)', () => {
  it('valid output -> DONE with a persisted, schema-valid analysis', async () => {
    const { repo, queue } = freshPipeline();
    const id = submit(repo, queue, 'I love this app, it is fast. Please add dark mode.');

    expect(await waitForTerminal(repo, id)).toBe('DONE');

    const analysis = repo.latestAnalysis(id);
    expect(analysis?.valid).toBe(true);
    expect(analysis?.attempt).toBe(1);
    expect(analysis?.sentiment).toBe('positive');
    expect(analysis?.featureRequests?.length).toBeGreaterThan(0);
    expect(analysis?.rawResponse).toBeTruthy();
    expect(analysis?.error).toBeNull();
    await queue.stop();
  });

  it('schema-invalid output -> FAILED, raw persisted, reason recorded', async () => {
    const { repo, queue } = freshPipeline();
    const id = submit(repo, queue, 'trigger __FAIL_SCHEMA__ please');

    expect(await waitForTerminal(repo, id)).toBe('FAILED');

    const analysis = repo.latestAnalysis(id);
    expect(analysis?.valid).toBe(false);
    expect(analysis?.sentiment).toBeNull();
    expect(analysis?.rawResponse).toContain('ecstatic'); // raw kept verbatim
    expect(analysis?.error).toMatch(/schema validation failed/);
    await queue.stop();
  });

  it('non-JSON output -> FAILED with an honest "not valid JSON" reason', async () => {
    const { repo, queue } = freshPipeline();
    const id = submit(repo, queue, 'trigger __FAIL_PARSE__ here');

    expect(await waitForTerminal(repo, id)).toBe('FAILED');

    const analysis = repo.latestAnalysis(id);
    expect(analysis?.valid).toBe(false);
    expect(analysis?.error).toBe('model response was not valid JSON');
    expect(analysis?.rawResponse).toBeTruthy();
    await queue.stop();
  });

  it('transient error -> FAILED, classified as transient', async () => {
    const { repo, queue } = freshPipeline();
    const id = submit(repo, queue, 'trigger __FAIL_TRANSIENT__ now');

    expect(await waitForTerminal(repo, id)).toBe('FAILED');

    const analysis = repo.latestAnalysis(id);
    expect(analysis?.valid).toBe(false);
    expect(analysis?.error).toMatch(/transient LLM error/);
    await queue.stop();
  });
});

describe('repo.finishAttempt: atomic write + transition', () => {
  it('commits the analysis and the transition together when the CAS matches', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);
    const fb = repo.create({ content: 'x', contentHash: hashContent('x') });
    repo.setStatus(fb.id, 'ANALYZING', 'RECEIVED');

    const { analysis, transitioned } = repo.finishAttempt(
      {
        feedbackId: fb.id,
        attempt: 1,
        rawResponse: '{}',
        sentiment: 'neutral',
        featureRequests: [],
        actionableInsight: 'do a thing',
        valid: true,
        error: null,
      },
      { to: 'DONE', from: 'ANALYZING' },
    );

    expect(transitioned).toBe(true);
    expect(analysis).not.toBeNull();
    expect(repo.findById(fb.id)?.status).toBe('DONE');
    expect(repo.latestAnalysis(fb.id)?.valid).toBe(true);
  });

  it('writes nothing when the CAS is lost (item not in the expected state)', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = createFeedbackRepo(db);
    const fb = repo.create({ content: 'y', contentHash: hashContent('y') }); // still RECEIVED

    const { analysis, transitioned } = repo.finishAttempt(
      {
        feedbackId: fb.id,
        attempt: 1,
        rawResponse: '{}',
        sentiment: 'neutral',
        featureRequests: [],
        actionableInsight: 'do a thing',
        valid: true,
        error: null,
      },
      { to: 'DONE', from: 'ANALYZING' }, // but it's RECEIVED -> CAS matches nothing
    );

    expect(transitioned).toBe(false);
    expect(analysis).toBeNull();
    expect(repo.findById(fb.id)?.status).toBe('RECEIVED'); // unchanged
    expect(repo.latestAnalysis(fb.id)).toBeUndefined(); // no row persisted
  });
});

describe('vertical slice: HTTP POST -> async analysis -> GET', () => {
  let app: ReturnType<typeof buildServer> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('POST returns 202 RECEIVED; GET eventually reports DONE with analysis', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });

    const post = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { content: 'The export feature is great but I wish it supported CSV.' },
    });
    expect(post.statusCode).toBe(202);
    const { id, status } = post.json<{ id: string; status: string }>();
    expect(status).toBe('RECEIVED');

    // Poll the read API until the worker finishes.
    const deadline = Date.now() + 1000;
    let body: { status: string; analysis: { valid: boolean } | null } = { status: 'RECEIVED', analysis: null };
    for (;;) {
      const get = await app.inject({ method: 'GET', url: `/feedback/${id}` });
      expect(get.statusCode).toBe(200);
      body = get.json();
      if (body.status === 'DONE' || body.status === 'FAILED') break;
      if (Date.now() > deadline) throw new Error('timed out waiting for analysis');
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(body.status).toBe('DONE');
    expect(body.analysis?.valid).toBe(true);
  });

  it('POST with empty content -> 400 ValidationError', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });

    const res = await app.inject({ method: 'POST', url: '/feedback', payload: { content: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('ValidationError');
  });

  it('GET unknown id -> 404 NotFound', async () => {
    const db = openDatabase(':memory:');
    app = buildServer({ db, llm: createFakeLLMClient() });

    const res = await app.inject({ method: 'GET', url: '/feedback/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});
