import { z } from 'zod';

/**
 * The AIAnalysis contract — the single strict schema the LLM output must satisfy.
 *
 * This is the heart of the "quality of AI integration" requirement: we force the model
 * toward this shape (P3 derives a JSON Schema from it for `response_format`) and then
 * re-validate the response against it with Zod regardless. `.strict()` rejects unknown
 * keys so a chatty model can't smuggle extra fields past us. Anything that fails this
 * schema is treated as a permanent (schema-invalid) failure, never a crash.
 */
export const SentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export type Sentiment = z.infer<typeof SentimentSchema>;

export const FeatureRequestSchema = z
  .object({
    title: z.string().min(1),
    // Model-reported confidence; bounded so an out-of-range value is a validation failure.
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type FeatureRequest = z.infer<typeof FeatureRequestSchema>;

export const AIAnalysisSchema = z
  .object({
    sentiment: SentimentSchema,
    // An empty array is valid (no requests found); malformed entries are not.
    feature_requests: z.array(FeatureRequestSchema),
    actionable_insight: z.string().min(1),
  })
  .strict();
export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;

/**
 * One persisted analysis attempt, as the repository exposes it (DB columns decoded:
 * `feature_requests` parsed from JSON text, `valid` from 0|1). One row per attempt so
 * retry history is preserved. The structured fields are null when the attempt failed
 * (e.g. unparseable output) — `raw_response` and `error` capture what happened.
 */
export interface AnalysisRecord {
  id: string;
  feedbackId: string;
  attempt: number;
  rawResponse: string | null;
  sentiment: Sentiment | null;
  featureRequests: FeatureRequest[] | null;
  actionableInsight: string | null;
  valid: boolean;
  error: string | null;
  createdAt: string;
}
