import { createHttpTwentyCrmClient, readHttpClientConfigFromEnv } from './twenty/http-twenty-crm-client';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import { WORKSPACE_ID_PATTERN } from './act/find-foreign-workspace-id';
import { startGateway } from './server';

let httpConfig: ReturnType<typeof readHttpClientConfigFromEnv>;

try {
  httpConfig = readHttpClientConfigFromEnv(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid Twenty client config.');
  process.exit(1);
}
const client = httpConfig
  ? createHttpTwentyCrmClient(httpConfig)
  : createMockTwentyCrmClient();

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

const gateway = await startGateway({
  client,
  port,
  host,
  boundWorkspaceId,
});

console.log(`rex-ai-gateway listening on ${gateway.url}`);
console.log(
  httpConfig
    ? `twenty client: http (${httpConfig.style ?? 'rest'})`
    : 'twenty client: mock (in-memory, fictional records only)',
);
