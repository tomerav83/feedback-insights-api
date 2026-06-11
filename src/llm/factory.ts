import { config } from '../config';
import { createFakeLLMClient } from './fake';
import { createOpenAICompatibleClient } from './openai-compatible';
import type { LLMClient } from './types';

/**
 * Chooses the LLM backend from config. `llmMode` is 'fake' unless LLM_BASE_URL is set, so
 * the default path needs no key, no network, and no cost.
 *
 * When LLM_BASE_URL is set we go live via the OpenAI-compatible client
 * (`createOpenAICompatibleClient`), which talks to any OpenAI-API server (hosted OpenAI,
 * local Ollama, vLLM, ...). The fake remains the zero-config default so a run that forgot to
 * set LLM_BASE_URL can't silently masquerade as live.
 */
export function createLLMClient(): LLMClient {
  if (config.llmMode === 'fake') {
    return createFakeLLMClient();
  }
  return createOpenAICompatibleClient();
}
