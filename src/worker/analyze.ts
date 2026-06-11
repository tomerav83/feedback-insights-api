import { z } from 'zod';
import { config } from '../config';
import type { Logger } from '../lib/logger';
import type { LLMClient } from '../llm/types';
import { TransientLLMError } from '../llm/types';
import { AIAnalysisSchema } from '../schemas/analysis';
import type { FeedbackRepo, InsertAnalysisInput } from '../repositories/feedback.repo';

export interface AnalyzerDeps {
  repo: FeedbackRepo;
  llm: LLMClient;
  logger?: Logger;
  /** Max in-pass auto-retries on transient errors before FAILED. Defaults to config. */
  maxAutoRetries?: number;
  /** Injectable sleep so tests can skip the real backoff wait. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Base for exponential backoff between transient auto-retries: 250ms, 500ms, 1s, ... */
const BACKOFF_BASE_MS = 250;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Compact, single-line rendering of Zod issues for the persisted `error` column. */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Processes exactly one feedback item end-to-end — the body of the state machine:
 *
 *   RECEIVED --claim--> ANALYZING --[valid output]--> DONE
 *                                 --[invalid output / transient error]--> FAILED
 *
 * Every path persists exactly one `analyses` row (raw response kept verbatim, even on
 * failure) and ends in a terminal state. Nothing here throws: an adversarial model output
 * becomes a FAILED row, never a crashed worker.
 *
 * Retry policy: a transient infra error (network/timeout/429/5xx, surfaced as
 * TransientLLMError) is auto-retried up to `maxAutoRetries` times with exponential backoff,
 * all WITHIN this one ANALYZING claim. Only the terminal outcome is persisted as a single
 * analysis row — the transient retries are infra hiccups, not distinct model attempts, so
 * burning an `attempt` row on each would muddy the history. The `attempt` counter therefore
 * tracks worker passes (a manual POST /:id/retry starts a new pass with a new attempt number).
 * A schema-invalid output is permanent: persisted FAILED immediately, never retried (no point
 * re-prompting a misbehaving model — see tradeoffs).
 */
export function createAnalyzer(deps: AnalyzerDeps): (feedbackId: string) => Promise<void> {
  const { repo, llm, logger } = deps;
  const maxAutoRetries = deps.maxAutoRetries ?? config.maxAutoRetries;
  const sleep = deps.sleep ?? defaultSleep;

  return async function analyze(feedbackId: string): Promise<void> {
    // Claim the item with a compare-and-swap: only RECEIVED -> ANALYZING succeeds. If some
    // other path already moved it (double-enqueue, a racing retry), we are not the owner —
    // bail without touching it.
    const claimed = repo.setStatus(feedbackId, 'ANALYZING', 'RECEIVED');
    if (!claimed) {
      logger?.warn({ feedbackId }, 'analyze: item not in RECEIVED, skipping');
      return;
    }

    const feedback = repo.findById(feedbackId);
    if (!feedback) {
      // Should be unreachable (we just updated it), but never assume.
      logger?.error({ feedbackId }, 'analyze: item vanished after claim');
      return;
    }

    const attempt = repo.nextAttempt(feedbackId);

    // Persist the attempt and flip out of ANALYZING atomically (see repo.finishAttempt). If
    // the CAS is lost (item no longer ANALYZING — e.g. concurrently recovered/retried), we
    // are no longer the owner: write nothing and log, rather than clobber another path.
    const commit = (
      result: Pick<
        InsertAnalysisInput,
        'rawResponse' | 'sentiment' | 'featureRequests' | 'actionableInsight' | 'valid' | 'error'
      >,
      to: 'DONE' | 'FAILED',
    ): void => {
      const { transitioned } = repo.finishAttempt(
        { feedbackId, attempt, ...result },
        { to, from: 'ANALYZING' },
      );
      if (!transitioned) {
        logger?.warn({ feedbackId, attempt }, 'analyze: transition lost, item no longer ANALYZING');
      }
    };

    // Up to (1 + maxAutoRetries) tries; only transient errors consume a retry. Success and
    // schema-invalid both return inside the loop, so we fall through past it only when the
    // transient budget is exhausted.
    for (let tryIdx = 0; tryIdx <= maxAutoRetries; tryIdx++) {
      try {
        const result = await llm.analyze(feedback.content);
        const parsed = AIAnalysisSchema.safeParse(result.json);

        if (parsed.success) {
          commit(
            {
              rawResponse: result.raw,
              sentiment: parsed.data.sentiment,
              featureRequests: parsed.data.feature_requests,
              actionableInsight: parsed.data.actionable_insight,
              valid: true,
              error: null,
            },
            'DONE',
          );
          logger?.info({ feedbackId, attempt }, 'analyze: DONE');
          return;
        }

        // Parsed-but-wrong-shape, or non-JSON (json === undefined). Either way this is a
        // permanent, schema-invalid failure: persist the raw output + a precise reason and
        // stop — re-prompting a misbehaving model just burns tokens (see tradeoffs).
        const error =
          result.json === undefined
            ? 'model response was not valid JSON'
            : `schema validation failed: ${formatZodIssues(parsed.error)}`;
        commit(
          {
            rawResponse: result.raw,
            sentiment: null,
            featureRequests: null,
            actionableInsight: null,
            valid: false,
            error,
          },
          'FAILED',
        );
        logger?.warn({ feedbackId, attempt, error }, 'analyze: FAILED (schema-invalid)');
        return;
      } catch (err) {
        const transient = err instanceof TransientLLMError;
        const reason = err instanceof Error ? err.message : String(err);

        // Transient and still have budget left: back off and retry within this same claim.
        if (transient && tryIdx < maxAutoRetries) {
          const delay = BACKOFF_BASE_MS * 2 ** tryIdx;
          logger?.warn(
            { feedbackId, attempt, try: tryIdx + 1, delay, reason },
            'analyze: transient error, retrying',
          );
          await sleep(delay);
          continue;
        }

        // Either an exhausted transient budget or a non-transient throw: terminal FAILED.
        // Persist a row so the failure is inspectable and the item is manually retriable.
        const error = transient
          ? `transient LLM error after ${tryIdx + 1} attempt(s): ${reason}`
          : `unexpected error: ${reason}`;
        commit(
          {
            rawResponse: transient ? err.raw : null,
            sentiment: null,
            featureRequests: null,
            actionableInsight: null,
            valid: false,
            error,
          },
          'FAILED',
        );
        logger?.error({ feedbackId, attempt, error }, 'analyze: FAILED (error)');
        return;
      }
    }
  };
}
