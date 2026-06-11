import { config } from '../config';
import { createFakeLLMClient } from './fake';
import type { LLMClient } from './types';

/**
 * Chooses the LLM backend from config. `llmMode` is 'fake' unless LLM_BASE_URL is set, so
 * the default path needs no key, no network, and no cost.
 *
 * P3 replaces the throw with the OpenAI-compatible client (`createOpenAICompatibleClient`).
 * Until then, configuring a live backend is an explicit, loud error rather than a silent
 * fallback to the fake — so a misconfigured "I thought it was live" run can't go unnoticed.
 */
export function createLLMClient(): LLMClient {
  if (config.llmMode === 'fake') {
    return createFakeLLMClient();
  }
  throw new Error(
    'Live LLM client is not implemented yet (P3). Unset LLM_BASE_URL to use the offline fake.',
  );
}
