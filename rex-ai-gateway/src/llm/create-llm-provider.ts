import { createMockLlmProvider } from './mock-llm-provider';
import { createOpenAiLlmProvider } from './openai-llm-provider';
import type { LlmProvider } from './llm-provider';
import type { LlmConfig } from './read-llm-config';

export function createLlmProvider(config: LlmConfig): LlmProvider {
  if (config.provider === 'openai') {
    return createOpenAiLlmProvider(config);
  }

  return createMockLlmProvider();
}
