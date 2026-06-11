import { z } from 'zod';
import type { Logger } from '../lib/logger';
import type { LLMClient } from '../llm/types';
import { TransientLLMError } from '../llm/types';
import { AIAnalysisSchema } from '../schemas/analysis';
import type { FeedbackRepo, InsertAnalysisInput } from '../repositories/feedback.repo';

export interface AnalyzerDeps {
  repo: FeedbackRepo;
  llm: LLMClient;
  logger?: Logger;
}

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
 * P2 scope: a single attempt — transient errors go straight to FAILED. P4 wraps this with
 * bounded auto-retry + backoff before the transient -> FAILED transition.
 */
export function createAnalyzer(deps: AnalyzerDeps): (feedbackId: string) => Promise<void> {
  const { repo, llm, logger } = deps;

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
    } catch (err) {
      // Transient infra failure (or an unexpected throw). P2 sends both to FAILED; P4 will
      // auto-retry the transient class first. Persist a row so the failure is inspectable
      // and the item is manually retriable.
      const transient = err instanceof TransientLLMError;
      const reason = err instanceof Error ? err.message : String(err);
      const error = transient ? `transient LLM error: ${reason}` : `unexpected error: ${reason}`;
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
    }
  };
}
