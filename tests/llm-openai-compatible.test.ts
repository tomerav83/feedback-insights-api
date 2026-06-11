/**
 * Unit tests for the live OpenAI-compatible LLM client.
 *
 * The `openai` SDK is mocked with vi.hoisted so the mock fn is shared across
 * the vi.mock factory and the test bodies. The implementation under test
 * (src/llm/openai-compatible.ts) is authored by a teammate concurrently; if
 * it is absent at run time the import will throw a module-not-found error,
 * which is expected until the impl lands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoist the mock fn so it is available both inside the vi.mock factory and in
// the test bodies — the standard Vitest pattern for sharing a spy across the
// hoisting boundary.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
    constructor(_opts?: unknown) {}
  },
}));

import { createOpenAICompatibleClient } from '../src/llm/openai-compatible';
import { TransientLLMError } from '../src/llm/types';

/** Build a minimal completion response shape with a given content string. */
function completionWith(content: string) {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  create.mockReset();
});

describe('createOpenAICompatibleClient — live mode', () => {
  it('mode is "live"', () => {
    const client = createOpenAICompatibleClient();
    expect(client.mode).toBe('live');
  });

  it('valid JSON output: returns raw string + parsed json', async () => {
    const client = createOpenAICompatibleClient();
    const payload = {
      sentiment: 'positive',
      feature_requests: [{ title: 'dark mode', confidence: 0.8 }],
      actionable_insight: 'ship dark mode',
    };
    const jsonStr = JSON.stringify(payload);
    create.mockResolvedValueOnce(completionWith(jsonStr));

    const result = await client.analyze('some feedback');

    expect(result.raw).toBe(jsonStr);
    expect(result.json).toEqual(payload);
    expect(client.mode).toBe('live');
  });

  it('non-JSON output: does NOT throw; raw is the prose, json is undefined', async () => {
    const client = createOpenAICompatibleClient();
    const prose = 'Sure! here you go: {nope';
    create.mockResolvedValueOnce(completionWith(prose));

    const result = await client.analyze('some feedback');

    expect(result.raw).toBe(prose);
    expect(result.json).toBeUndefined();
  });

  it('null/missing content: does NOT throw; raw is empty string, json is undefined', async () => {
    const client = createOpenAICompatibleClient();
    // Simulate the SDK returning null for message.content (e.g. function-call finish reason).
    create.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

    const result = await client.analyze('some feedback');

    expect(result.raw).toBe('');
    expect(result.json).toBeUndefined();
  });

  it('transient error — 429 rate limit: rejects with TransientLLMError', async () => {
    const client = createOpenAICompatibleClient();
    create.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

    await expect(client.analyze('some feedback')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('transient error — 5xx server error: rejects with TransientLLMError', async () => {
    const client = createOpenAICompatibleClient();
    create.mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 503 }));

    await expect(client.analyze('some feedback')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('transient error — connection error with no status: rejects with TransientLLMError', async () => {
    const client = createOpenAICompatibleClient();
    create.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(client.analyze('some feedback')).rejects.toBeInstanceOf(TransientLLMError);
  });

  it('permanent error — 4xx other than 429: rejects with a plain Error, NOT TransientLLMError', async () => {
    const client = createOpenAICompatibleClient();
    create.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(client.analyze('some feedback')).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && !(e instanceof TransientLLMError),
    );
  });

  it('forwards user content into SDK call and sets response_format.type to json_schema', async () => {
    const client = createOpenAICompatibleClient();
    create.mockResolvedValueOnce(completionWith('{}'));

    await client.analyze('hello world');

    const callArgs = create.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    const hasContent = callArgs.messages.some((m) => m.content === 'hello world');
    expect(hasContent).toBe(true);
    expect(callArgs.response_format.type).toBe('json_schema');
  });
});
