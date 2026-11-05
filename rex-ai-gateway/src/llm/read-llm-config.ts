export type LlmConfig =
  | { provider: 'mock' }
  | { provider: 'openai'; baseUrl: string; apiKey: string; model: string };

export function readLlmConfigFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const provider = env.REX_AI_PROVIDER?.trim() || 'mock';

  if (provider === 'mock') {
    return { provider: 'mock' };
  }

  if (provider !== 'openai') {
    throw new Error('REX_AI_PROVIDER must be "mock" or "openai".');
  }

  const baseUrl = env.REX_AI_BASE_URL?.trim() || '';
  const apiKey = env.REX_AI_API_KEY?.trim() || '';
  const model = env.REX_AI_MODEL?.trim() || '';

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      'REX_AI_PROVIDER=openai requires REX_AI_BASE_URL, REX_AI_API_KEY, and REX_AI_MODEL.',
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('REX_AI_BASE_URL must be an http(s) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('REX_AI_BASE_URL must be an http(s) URL.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('REX_AI_BASE_URL must not include credentials.');
  }

  return { provider: 'openai', baseUrl, apiKey, model };
}
