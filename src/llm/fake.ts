import type { AIAnalysis } from '../schemas/analysis';
import { type LLMAnalysisResult, type LLMClient, TransientLLMError } from './types';

/**
 * Deterministic, offline fake LLM — the default backend when no LLM_BASE_URL is set, and
 * the backend every test runs against. No key, no network, no cost: `npm start` exercises
 * the full RECEIVED -> ANALYZING -> DONE/FAILED pipeline out of the box.
 *
 * "Deterministic" is the point: the same content always yields the same analysis, so the
 * demo and the tests are reproducible. Sentiment and feature-requests are derived from
 * trivial keyword heuristics — good enough to produce a plausible, schema-valid analysis;
 * the live model does the actual reasoning.
 *
 * Failure injection — double-underscore sentinels (won't collide with real feedback) let a
 * test or the demo drive each defensive branch on demand:
 *   __FAIL_PARSE__      -> returns non-JSON text        -> worker marks schema-invalid (FAILED)
 *   __FAIL_SCHEMA__     -> returns JSON of the wrong shape -> worker marks schema-invalid (FAILED)
 *   __FAIL_TRANSIENT__  -> throws TransientLLMError      -> worker treats as transient (retry/FAILED)
 */

const NEGATIVE = ['bad', 'hate', 'crash', 'broken', 'slow', 'terrible', 'awful', 'bug', 'error', 'fail', 'worst', 'annoying'];
const POSITIVE = ['love', 'great', 'awesome', 'good', 'excellent', 'nice', 'amazing', 'fast', 'perfect', 'wonderful', 'best'];
const REQUEST_CUES = ['wish', 'would be nice', 'please add', 'feature', 'support for', 'add ', 'ability to', 'allow', 'i want', "i'd like"];

function scoreSentiment(text: string): AIAnalysis['sentiment'] {
  const lower = text.toLowerCase();
  const neg = NEGATIVE.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
  const pos = POSITIVE.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function extractFeatureRequests(text: string): AIAnalysis['feature_requests'] {
  const lower = text.toLowerCase();
  if (!REQUEST_CUES.some((cue) => lower.includes(cue))) return [];
  // One synthetic request titled from a trimmed snippet of the content; deterministic
  // confidence so the same input always scores the same.
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
  return [{ title, confidence: 0.5 }];
}

function analyzeContent(content: string): AIAnalysis {
  return {
    sentiment: scoreSentiment(content),
    feature_requests: extractFeatureRequests(content),
    actionable_insight:
      `Review this ${scoreSentiment(content)} feedback and follow up on any requested changes.`,
  };
}

export function createFakeLLMClient(): LLMClient {
  return {
    mode: 'fake',
    async analyze(content: string): Promise<LLMAnalysisResult> {
      if (content.includes('__FAIL_TRANSIENT__')) {
        throw new TransientLLMError('injected transient failure (fake LLM)');
      }
      if (content.includes('__FAIL_PARSE__')) {
        // Prose-wrapped, unparseable — the classic local-model failure mode.
        const raw = 'Sure! Here is the analysis: {sentiment: positive, ...';
        return { raw, json: undefined };
      }
      if (content.includes('__FAIL_SCHEMA__')) {
        // Parses as JSON but violates the contract (bad enum + out-of-range confidence).
        const bad = {
          sentiment: 'ecstatic',
          feature_requests: [{ title: 'dark mode', confidence: 5 }],
          actionable_insight: '',
        };
        return { raw: JSON.stringify(bad), json: bad };
      }
      const analysis = analyzeContent(content);
      return { raw: JSON.stringify(analysis), json: analysis };
    },
  };
}
