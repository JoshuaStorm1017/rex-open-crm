import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { executeAct, type ExecuteActOptions } from './act/execute-act';
import { proposeAct } from './act/propose-act';
import { toolCatalog } from './act/tool-schema';
import { isRecord } from './is-record';
import { refusal, type ActResult, type PlanResult } from './act/types';
import { AuditLog, type AuditEntry } from './audit/audit-log';
import { bearerMatches } from './http/bearer-auth';
import { IdempotencyStore, readIdempotencyKey } from './http/idempotency-store';
import { readActor } from './http/read-actor';
import { createMockLlmProvider } from './llm/mock-llm-provider';
import type { LlmProvider } from './llm/llm-provider';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const ACT_PATH = '/v1/ai/act';
const PLAN_PATH = '/v1/ai/plan';
const TOOLS_PATH = '/v1/ai/tools';
const AUDIT_PATH = '/v1/ai/audit';
const KNOWN_PATHS = new Set([ACT_PATH, PLAN_PATH, TOOLS_PATH, AUDIT_PATH]);
const MAX_BODY_BYTES = 64 * 1024;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, authorization, idempotency-key, x-rex-actor, if-match',
  'access-control-expose-headers': 'idempotency-replayed',
};

export type GatewayOptions = ExecuteActOptions & {
  client: TwentyCrmClient;
  port?: number;
  host?: string;
  bearerToken?: string;
  llm?: LlmProvider;
  audit?: AuditLog;
  idempotency?: IdempotencyStore;
};

export type RunningGateway = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

type GatewayRuntime = {
  client: TwentyCrmClient;
  boundWorkspaceId?: string;
  bearerToken?: string;
  llm: LlmProvider;
  audit: AuditLog;
  idempotency: IdempotencyStore;
};

export function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;
  const runtime: GatewayRuntime = {
    client: options.client,
    boundWorkspaceId: options.boundWorkspaceId,
    bearerToken: options.bearerToken,
    llm: options.llm ?? createMockLlmProvider(),
    audit: options.audit ?? new AuditLog(),
    idempotency: options.idempotency ?? new IdempotencyStore(),
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      const message = error instanceof Error ? error.message : 'Unexpected error';
      sendJson(response, 500, { ok: false, message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Gateway failed to bind a TCP port'));
        return;
      }

      resolve({
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: GatewayRuntime,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const actor = readActor(headerValue(request.headers['x-rex-actor']));

  if (!KNOWN_PATHS.has(url.pathname)) {
    sendJson(response, 404, { ok: false, message: 'Not found' });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS_HEADERS);
    response.end();
    return;
  }

  if (runtime.bearerToken && !bearerMatches(headerValue(request.headers.authorization), runtime.bearerToken)) {
    const body = refusal(
      'unauthorized',
      'Authorization bearer token is missing or incorrect.',
    );
    remember(runtime, {
      actor: 'anonymous',
      action: url.pathname === PLAN_PATH ? 'plan' : 'act',
      summary: body.message,
      tools: [],
      recordIds: [],
      ok: false,
      reason: body.reason,
    });
    sendJson(response, 401, body);
    return;
  }

  if (request.method === 'GET' && url.pathname === TOOLS_PATH) {
    sendJson(response, 200, { ok: true, ...toolCatalog() });
    return;
  }

  if (request.method === 'GET' && url.pathname === AUDIT_PATH) {
    sendJson(response, 200, { ok: true, entries: runtime.audit.list() });
    return;
  }

  if (request.method !== 'POST' || (url.pathname !== ACT_PATH && url.pathname !== PLAN_PATH)) {
    sendJson(response, 405, { ok: false, message: 'Method not allowed' });
    return;
  }

  const rawBody = await readBody(request);

  if (rawBody === undefined) {
    sendJson(response, 400, {
      ok: false,
      refused: true,
      reason: 'invalid_request',
      message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
    });
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    const body = refusal('invalid_request', 'Body must be JSON.');
    rememberOutcome(runtime, actor, url.pathname, false, body);
    sendJson(response, 400, body);
    return;
  }

  const confirmed = isRecord(parsed) && parsed.confirmed === true;

  if (url.pathname === PLAN_PATH) {
    const result = await proposeAct(parsed, runtime.client, runtime.llm, {
      boundWorkspaceId: runtime.boundWorkspaceId,
    });
    rememberOutcome(runtime, actor, PLAN_PATH, confirmed, result);
    sendJson(response, statusFor(result), result);
    return;
  }

  const idempotencyKey = readIdempotencyKey(headerValue(request.headers['idempotency-key']));

  if (idempotencyKey === 'invalid') {
    const body = refusal(
      'invalid_request',
      'Idempotency-Key must be 8–200 characters of letters, numbers, dot, colon, underscore, or hyphen.',
    );
    rememberOutcome(runtime, actor, ACT_PATH, confirmed, body);
    sendJson(response, 400, body);
    return;
  }

  const execute = async () => {
    const result = await executeAct(parsed, runtime.client, {
      boundWorkspaceId: runtime.boundWorkspaceId,
    });
    return { status: statusFor(result), body: result };
  };

  if (!idempotencyKey) {
    const result = await execute();
    rememberOutcome(runtime, actor, ACT_PATH, confirmed, result.body);
    sendJson(response, result.status, result.body);
    return;
  }

  const stored = await runtime.idempotency.run(idempotencyKey, rawBody, execute);

  if ('conflict' in stored && stored.conflict) {
    const body = refusal(
      'idempotency_conflict',
      'This idempotency key was already used with a different request body.',
    );
    rememberOutcome(runtime, actor, ACT_PATH, confirmed, body);
    sendJson(response, 409, body);
    return;
  }

  if (!('response' in stored)) {
    return;
  }

  rememberOutcome(runtime, actor, ACT_PATH, confirmed, stored.response.body, stored.replayed);
  sendJson(response, stored.response.status, stored.response.body, {
    ...(stored.replayed ? { 'idempotency-replayed': 'true' } : {}),
  });
}

function rememberOutcome(
  runtime: GatewayRuntime,
  actor: string,
  path: string,
  confirmed: boolean,
  body: unknown,
  replayed = false,
): void {
  const action = path === PLAN_PATH ? 'plan' : 'act';

  if (!isRecord(body)) {
    remember(runtime, {
      actor,
      action,
      summary: 'Unexpected result',
      tools: [],
      recordIds: [],
      ok: false,
      confirmed,
      replayed,
    });
    return;
  }

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const ok = body.ok === true;
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  const tools = ok ? toolNames(body) : [];
  const recordIds = ok ? collectRecordIds(body) : [];
  const summary =
    (isRecord(body.proposal) && typeof body.proposal.summary === 'string'
      ? body.proposal.summary
      : undefined) ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (ok ? `${action} completed` : 'Request failed');

  remember(runtime, {
    actor,
    action,
    workspaceId,
    summary,
    tools: ok && isRecord(body.proposal) ? proposalToolNames(body.proposal) : tools,
    recordIds,
    ok,
    confirmed: action === 'act' ? confirmed : undefined,
    reason,
    replayed,
  });
}

function proposalToolNames(proposal: Record<string, unknown>): string[] {
  if (!Array.isArray(proposal.tools)) {
    return [];
  }

  return proposal.tools
    .map((tool) => (isRecord(tool) && typeof tool.name === 'string' ? tool.name : undefined))
    .filter((name): name is string => name !== undefined);
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.results)) {
    return [];
  }

  return body.results
    .map((result) => (isRecord(result) && typeof result.tool === 'string' ? result.tool : undefined))
    .filter((name): name is string => name !== undefined);
}

function collectRecordIds(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.results)) {
    return [];
  }

  const ids: string[] = [];

  for (const result of body.results) {
    if (!isRecord(result)) {
      continue;
    }

    if (isRecord(result.record) && typeof result.record.id === 'string') {
      ids.push(result.record.id);
    }

    if (Array.isArray(result.records)) {
      for (const record of result.records) {
        if (isRecord(record) && typeof record.id === 'string') {
          ids.push(record.id);
        }
      }
    }
  }

  return ids;
}

function remember(
  runtime: GatewayRuntime,
  entry: Omit<AuditEntry, 'id' | 'at'>,
): void {
  runtime.audit.record(entry);
}

function statusFor(result: ActResult | PlanResult): number {
  if (result.ok) {
    return 200;
  }

  if (result.reason === 'upstream_error') {
    return 502;
  }

  if (!('refused' in result) || !result.refused) {
    return 400;
  }

  if (result.reason === 'unauthorized') {
    return 401;
  }

  if (result.reason === 'not_found') {
    return 404;
  }

  if (result.reason === 'idempotency_conflict') {
    return 409;
  }

  if (result.reason === 'precondition_failed') {
    return 412;
  }

  return 400;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...CORS_HEADERS,
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      return undefined;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
