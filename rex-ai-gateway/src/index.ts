import { createHttpTwentyCrmClient, readHttpClientConfigFromEnv } from './twenty/http-twenty-crm-client';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import { WORKSPACE_ID_PATTERN } from './act/find-foreign-workspace-id';
import { createMockAuthenticator, createTwentyAuthenticator } from './auth/authenticate';
import { readAllowedOrigins } from './http/cors';
import { assertProviderHostIsPublic, assertPublicProviderBaseUrl } from './http/public-url';
import { createLlmProvider } from './llm/create-llm-provider';
import { readLlmConfigFromEnv } from './llm/read-llm-config';
import { isLoopbackHost, startGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import path from 'node:path';

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
const authenticator = httpConfig
  ? createTwentyAuthenticator(httpConfig.apiUrl)
  : createMockAuthenticator();
const statePath =
  process.env.REX_AI_STATE_PATH?.trim() || path.join(process.cwd(), 'data', 'gateway-state.sqlite');
const state = openGatewayState(statePath);

const boundWorkspaceId = process.env.TWENTY_WORKSPACE_ID?.trim() || undefined;

if (boundWorkspaceId && !WORKSPACE_ID_PATTERN.test(boundWorkspaceId)) {
  console.error('TWENTY_WORKSPACE_ID must be a gateway token such as "ws_demo".');
  process.exit(1);
}

const port = Number(process.env.REX_AI_GATEWAY_PORT ?? 8787);
const host = process.env.REX_AI_GATEWAY_HOST ?? 'localhost';

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
  authenticator,
  proposals: state.proposals,
  idempotency: state.idempotency,
  audit: state.audit,
  undos: state.undos,
  onClose: () => state.close(),
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
  httpConfig
    ? 'auth: signed-in Twenty session, or gateway bearer plus X-Twenty-Authorization'
    : 'auth: mock member (X-Rex-Member or a session cookie). Nothing is sent to Twenty.',
);
if (process.env.TWENTY_API_KEY?.trim()) {
  console.log('TWENTY_API_KEY is ignored. Writes use the caller credential.');
}
console.log(`state: ${statePath}`);
