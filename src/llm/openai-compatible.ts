import OpenAI from 'openai';

import { config } from '../config';
import { AIAnalysisSchema } from '../schemas/analysis';
import { z } from 'zod';
import { type LLMAnalysisResult, type LLMClient, TransientLLMError } from './types';

/**
 * The live, OpenAI-compatible LLM client — the backend whenever LLM_BASE_URL is set. Talks
 * to any server that speaks the OpenAI chat-completions API (hosted OpenAI, a local Ollama,
 * vLLM, etc.) via the official `openai` SDK pointed at the configured baseURL.
 *
 * Defense-in-depth on output shape (two independent layers):
 *  1. Forced output: we send `response_format: json_schema` with `strict: true` and a schema
 *     DERIVED from AIAnalysisSchema, so a compliant server is constrained to emit exactly the
 *     contract shape (no prose, no extra keys). This is the "make the model behave" layer.
 *  2. Re-validation: we DON'T trust that. Per the LLMClient contract this client does only
 *     transport + a best-effort JSON.parse and hands `{ raw, json }` back; the worker
 *     re-validates `json` against the same Zod schema. Local models honour `json_schema`
 *     unevenly, so the worker is the real gate. Keeping validation out of here preserves the
 *     contract's clean split between "transport working?" and "output well-formed?".
 *
 * Error classification is DUCK-TYPED on a numeric `status`, not `instanceof` of the SDK's
 * error classes. That keeps it provider-agnostic and trivially mockable: a test (or an
 * alternate provider) can throw any object with a `status` number and get the same routing,
 * without importing the SDK's error hierarchy.
 */

// Derived ONCE at module load from the single source of truth (AIAnalysisSchema) via Zod 4's
// built-in JSON-schema exporter — no hand-maintained duplicate to drift. Verified empirically
// (npx tsx -e ...): the default output already satisfies OpenAI strict structured-output mode
// — every object carries `additionalProperties: false` and lists every property in `required`,
// and the inner FeatureRequest object is inlined (no $ref/$defs to resolve). The retained
// minLength/minimum/maximum keywords are harmless: they fall within the subset
// current OpenAI strict mode accepts, lenient backends (e.g. Ollama) simply don't enforce them,
// and the worker re-validates with Zod regardless. We strip only the top-level `$schema` key.
const { $schema: _$schema, ...JSON_SCHEMA } = z.toJSONSchema(AIAnalysisSchema) as Record<
  string,
  unknown
>;

const SYSTEM_PROMPT = [
  'You are a product-feedback analysis engine.',
  'Given a single piece of user feedback, extract:',
  '1. "sentiment": the overall sentiment, exactly one of "positive", "neutral", or "negative".',
  '2. "feature_requests": an array of { "title", "confidence" } objects, where title is a short',
  '   description of a requested feature and confidence is a number from 0 to 1. Use an empty',
  '   array if the feedback requests no features.',
  '3. "actionable_insight": a single, non-empty sentence summarising what the team should do.',
  'Respond with ONLY a JSON object matching the provided schema. No prose, no markdown, no',
  'code fences.',
].join('\n');

// SDK default is 10 minutes; a hung/slow local model would pin a worker slot that long.
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Strip the configured API key from any text before it is thrown/logged/persisted. Some
 * OpenAI-compatible backends echo the key in their error bodies; this closes that leak vector
 * (no-op for the local/Ollama path, where the key is the 'not-needed' placeholder).
 */
function redactSecret(text: string): string {
  const key = config.llm.apiKey;
  if (!key || key === 'not-needed') return text;
  return text.split(key).join('[redacted]');
}

export function createOpenAICompatibleClient(): LLMClient {
  // Constructed per client (not at module load) so a test can call this directly. baseURL may
  // be undefined here when invoked outside the factory; we pass it through rather than throw —
  // guarding a missing LLM_BASE_URL is the factory's job, not the transport's.
  const client = new OpenAI({
    baseURL: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
    // Own the retry policy in the worker, not here: disable the SDK's built-in retries so
    // the worker's attempt counter + backoff are the single source of truth (no hidden retries).
    maxRetries: 0,
    // Fail fast instead of holding a worker slot for the SDK's 10-minute default; a timeout
    // surfaces as a no-status connection error, which the classifier below treats as transient.
    timeout: REQUEST_TIMEOUT_MS,
  });

  return {
    mode: 'live',
    async analyze(content: string): Promise<LLMAnalysisResult> {
      let raw: string;
      try {
        const completion = await client.chat.completions.create({
          model: config.llm.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'feedback_analysis',
              strict: true,
              schema: JSON_SCHEMA,
            },
          },
        });
        raw = completion.choices[0]?.message?.content ?? '';
      } catch (err) {
        if (err instanceof TransientLLMError) throw err;
        const status =
          typeof err === 'object' && err !== null && 'status' in err &&
          typeof (err as { status: unknown }).status === 'number'
            ? (err as { status: number }).status
            : undefined;
        // OpenAI-compatible SDK errors expose a numeric `status` for HTTP failures; connection/
        // timeout errors have none. 429, any 5xx, and all connection-level failures are transient.
        if (status === undefined || status === 429 || status >= 500) {
          throw new TransientLLMError(`LLM request failed: ${status ?? 'connection error'}`, {
            cause: err,
          });
        }
        // Permanent API error (e.g. 400/401/404): not retryable and not a malformed-body case.
        // Redact the key in case the backend echoed it in its error message (see redactSecret).
        throw new Error(
          `LLM request failed (HTTP ${status}): ${redactSecret(err instanceof Error ? err.message : String(err))}`,
        );
      }

      // Best-effort parse with its OWN local try/catch so a non-JSON body is a normal return
      // (json: undefined), never reaching the transport classifier above. The worker decides
      // DONE vs FAILED from here; this client never validates the analysis shape itself.
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      return { raw, json };
    },
  };
}
