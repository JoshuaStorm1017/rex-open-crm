import { createHttpTwentyCrmClient, readHttpClientConfigFromEnv } from './twenty/http-twenty-crm-client';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import { WORKSPACE_ID_PATTERN } from './act/find-foreign-workspace-id';
import { readAllowedOrigins } from './http/cors';
import { assertProviderHostIsPublic, assertPublicProviderBaseUrl } from './http/public-url';
import { createLlmProvider } from './llm/create-llm-provider';
import { readLlmConfigFromEnv } from './llm/read-llm-config';
import { isLoopbackHost, startGateway } from './server';

let httpConfig: ReturnType<typeof readHttpClientConfigFromEnv>;
let llmConfig: ReturnType<typeof readLlmConfigFromEnv>;

try {
  httpConfig = readHttpClientConfigFromEnv(process.env);
  llmConfig = readLlmConfigFromEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid gateway config.');
  process.exit(1);
}

if (llmConfig.provider === 'openai') {
  try {
    const providerUrl = assertPublicProviderBaseUrl(llmConfig.baseUrl);
    await assertProviderHostIsPublic(providerUrl.hostname);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid provider URL.');
    process.exit(1);
  }
}

const client = httpConfig
  ? createHttpTwentyCrmClient(httpConfig)
  : createMockTwentyCrmClient();
const llm = createLlmProvider(llmConfig);
const bearerToken = process.env.REX_AI_GATEWAY_TOKEN?.trim() || undefined;

const boundWorkspaceId = process.env.TWENTY_WORKSPACE_ID?.trim() || undefined;

if (boundWorkspaceId && !WORKSPACE_ID_PATTERN.test(boundWorkspaceId)) {
  console.error('TWENTY_WORKSPACE_ID must be a gateway token such as "ws_demo".');
  process.exit(1);
}

const port = Number(process.env.REX_AI_GATEWAY_PORT ?? 8787);
const host = process.env.REX_AI_GATEWAY_HOST ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('REX_AI_GATEWAY_PORT must be an integer from 0 to 65535.');
  process.exit(1);
}

if (!isLoopbackHost(host) && !bearerToken) {
  console.error('REX_AI_GATEWAY_TOKEN is required when REX_AI_GATEWAY_HOST is not loopback.');
  process.exit(1);
}

const allowedOrigins = readAllowedOrigins(process.env);

const gateway = await startGateway({
  client,
  llm,
  port,
  host,
  boundWorkspaceId,
  bearerToken,
  allowedOrigins,
});

console.log(`rex-ai-gateway listening on ${gateway.url}`);
console.log(
  httpConfig
    ? `twenty client: http (${httpConfig.style ?? 'rest'})`
    : 'twenty client: mock (in-memory, fictional records only)',
);
console.log(
  llmConfig.provider === 'openai'
    ? `llm: openai (${llmConfig.model})`
    : 'llm: mock (deterministic, no network)',
);
console.log(
  bearerToken
    ? 'auth: bearer token required'
    : 'auth: open on this process (set REX_AI_GATEWAY_TOKEN to require a bearer token)',
);
