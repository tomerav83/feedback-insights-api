/**
 * The LLM boundary. One narrow interface that both the deterministic fake and the real
 * OpenAI-compatible client implement, so the worker is written once against the contract
 * and never against a provider.
 *
 * Division of responsibility (deliberate):
 *  - The client's job is transport + JSON parsing only. It returns the raw model text
 *    ALWAYS (so it can be persisted verbatim even when the body is garbage) plus a
 *    best-effort parsed JSON value.
 *  - It does NOT validate against the AIAnalysis schema. Schema enforcement is the worker's
 *    job (Zod re-validation), keeping "is this transport working?" separate from "did the
 *    model produce a well-formed analysis?". That separation is exactly what lets the worker
 *    map the two failure kinds onto different state-machine outcomes.
 */
export interface LLMAnalysisResult {
  /** Raw text the model returned, persisted verbatim even when unparseable. */
  raw: string;
  /**
   * Best-effort JSON parse of `raw`. `undefined` specifically means the body was not valid
   * JSON (vs. a parsed-but-wrong-shape object, which the worker rejects via Zod). The worker
   * uses this distinction to write an honest failure reason.
   */
  json: unknown;
}

export interface LLMClient {
  /** Label surfaced by /health — never the key or endpoint. */
  readonly mode: 'live' | 'fake';
  /**
   * Send feedback content to the model and return raw text + best-effort parsed JSON.
   *
   * Contract:
   *  - Throws {@link TransientLLMError} for retryable infrastructure failures
   *    (network, timeout, 429, 5xx) — the worker treats these as transient.
   *  - Does NOT throw for a malformed/non-JSON/wrong-shape body. That is a normal return
   *    (with `json: undefined` for non-JSON) so the worker can mark it schema-invalid and
   *    persist the raw response, rather than crash.
   */
  analyze(content: string): Promise<LLMAnalysisResult>;
}

/**
 * Marks a retryable infrastructure failure (network/timeout/429/5xx) as distinct from a
 * malformed-output failure. The worker classifies on this type: transient -> bounded
 * auto-retry then FAILED; schema-invalid -> FAILED immediately (don't burn tokens looping).
 */
export class TransientLLMError extends Error {
  /** Any partial raw text recovered before the failure, persisted if present. */
  readonly raw: string | null;

  constructor(message: string, options?: { raw?: string | null; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransientLLMError';
    this.raw = options?.raw ?? null;
  }
}
