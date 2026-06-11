import { z } from 'zod';
import { config } from '../config';
import type { AnalysisRecord } from './analysis';

/**
 * Feedback DTOs and the lifecycle status enum.
 *
 * Request bodies/queries are validated here so the API boundary rejects bad input
 * before anything touches the DB or the LLM (empty/over-length content in particular).
 * The status set is the formal state machine: RECEIVED -> ANALYZING -> DONE | FAILED.
 */
export const FEEDBACK_STATUSES = ['RECEIVED', 'ANALYZING', 'DONE', 'FAILED'] as const;
export const FeedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;

/**
 * POST /feedback body. `content` is trimmed, must be non-empty, and is capped at
 * MAX_CONTENT_LENGTH — a defensive bound that also keeps a single request from
 * blowing the LLM context/budget. `.strict()` rejects stray fields.
 */
export const CreateFeedbackSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, 'content must not be empty')
      .max(
        config.maxContentLength,
        `content must be at most ${config.maxContentLength} characters`,
      ),
  })
  .strict();
export type CreateFeedbackBody = z.infer<typeof CreateFeedbackSchema>;

/** GET /feedback query: optional status filter + bounded pagination. */
export const ListFeedbackQuerySchema = z
  .object({
    status: FeedbackStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListFeedbackQuery = z.infer<typeof ListFeedbackQuerySchema>;

/** Path param for the single-item and retry routes. */
export const FeedbackIdParamSchema = z.object({ id: z.string().min(1) });
export type FeedbackIdParam = z.infer<typeof FeedbackIdParamSchema>;

/** A feedback row as stored/returned by the repository. */
export interface FeedbackRecord {
  id: string;
  content: string;
  contentHash: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
}

/** Read-API shape: a feedback item with its most recent analysis (null if none yet). */
export interface FeedbackWithAnalysis extends FeedbackRecord {
  analysis: AnalysisRecord | null;
}
