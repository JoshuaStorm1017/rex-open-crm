import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { compensate, partialFailure } from './act/compensate';
import { executeAct, type ExecuteActOptions } from './act/execute-act';
import { parseGatewayRequest } from './act/parse-request';
import { assertCanUndo, catalogForAudience, loadAudience } from './act/permissions';
import { proposeAct } from './act/propose-act';
import { isRecord } from './is-record';
import { refusal, upstreamFailure, type ActResult, type PlanResult } from './act/types';
import { createMockAuthenticator, type Authenticator } from './auth/authenticate';
import { withMemberCredential } from './auth/call-context';
import type { MemberPrincipal } from './auth/types';
import { AuditLog, type AuditAction, type AuditEntry } from './audit/audit-log';
import { corsHeadersFor, DEFAULT_ALLOWED_ORIGINS } from './http/cors';
import { IdempotencyStore, readIdempotencyKey } from './http/idempotency-store';
import { ProposalStore } from './http/proposal-store';
import { UndoStore } from './http/undo-store';
import { createMockLlmProvider } from './llm/mock-llm-provider';
import type { LlmProvider } from './llm/llm-provider';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const ACT_PATH = '/v1/ai/act';
const PLAN_PATH = '/v1/ai/plan';
const UNDO_PATH = '/v1/ai/undo';
const TOOLS_PATH = '/v1/ai/tools';
const AUDIT_PATH = '/v1/ai/audit';
const KNOWN_PATHS = new Set([ACT_PATH, PLAN_PATH, UNDO_PATH, TOOLS_PATH, AUDIT_PATH]);
const MAX_BODY_BYTES = 64 * 1024;

export type GatewayOptions = ExecuteActOptions & {
  client: TwentyCrmClient;
  port?: number;
  host?: string;
  bearerToken?: string;
  llm?: LlmProvider;
  audit?: AuditLog;
  idempotency?: IdempotencyStore;
  proposals?: ProposalStore;
  undos?: UndoStore;
  allowedOrigins?: string[];
  authenticator?: Authenticator;
  onClose?: () => void;
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
  proposals: ProposalStore;
  undos: UndoStore;
  allowedOrigins: ReadonlySet<string>;
  authenticator: Authenticator;
  onClose?: () => void;
};

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;

  if (!isLoopbackHost(host) && !options.bearerToken) {
    return Promise.reject(
      new Error(
        'REX_AI_GATEWAY_TOKEN is required when the gateway host is not loopback.',
      ),
    );
  }

  const runtime: GatewayRuntime = {
    client: options.client,
    boundWorkspaceId: options.boundWorkspaceId,
    bearerToken: options.bearerToken,
    llm: options.llm ?? createMockLlmProvider(),
    audit: options.audit ?? new AuditLog(),
    idempotency: options.idempotency ?? new IdempotencyStore(),
    proposals: options.proposals ?? new ProposalStore(),
    undos: options.undos ?? new UndoStore(),
    allowedOrigins: new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS),
    authenticator: options.authenticator ?? createMockAuthenticator(),
    onClose: options.onClose,
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      console.error(error instanceof Error ? error.message : 'Unexpected error');
      sendJson(
        response,
        500,
        { ok: false, message: 'Unexpected error' },
        corsFor(request, runtime),
      );
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
            server.close((error) => {
              runtime.onClose?.();
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
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
  const cors = corsFor(request, runtime);

  if (!KNOWN_PATHS.has(url.pathname)) {
    sendJson(response, 404, { ok: false, message: 'Not found' }, cors);
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }

  const principal = await runtime.authenticator.authenticate(request, {
    bearerToken: runtime.bearerToken,
    allowedOrigins: runtime.allowedOrigins,
  });

  if (!principal) {
    const body = refusal(
      'unauthorized',
      'Sign in to Twenty, or present the gateway bearer plus a Twenty access token. The actor header is ignored.',
    );
    remember(runtime, {
      memberId: 'anonymous',
      actor: 'anonymous',
      action: actionForPath(url.pathname),
      summary: body.message,
      tools: [],
      recordIds: [],
      ok: false,
      reason: body.reason,
    });
    sendJson(response, 401, body, cors);
    return;
  }

  await withMemberCredential(principal.credential, () =>
    handleAuthenticated(request, response, runtime, url, principal, cors),
  );
}

async function handleAuthenticated(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: GatewayRuntime,
  url: URL,
  principal: MemberPrincipal,
  cors: Record<string, string>,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === TOOLS_PATH) {
    const catalog = catalogForAudience(await loadAudience(runtime.client));

    if ('refused' in catalog) {
      sendJson(response, statusFor(catalog), catalog, cors);
      return;
    }

    sendJson(response, 200, { ok: true, ...catalog }, cors);
    return;
  }

  if (request.method === 'GET' && url.pathname === AUDIT_PATH) {
    sendJson(response, 200, { ok: true, entries: runtime.audit.list(principal.memberId) }, cors);
    return;
  }

  if (
    request.method !== 'POST' ||
    (url.pathname !== ACT_PATH && url.pathname !== PLAN_PATH && url.pathname !== UNDO_PATH)
  ) {
    sendJson(response, 405, { ok: false, message: 'Method not allowed' }, cors);
    return;
  }

  const rawBody = await readBody(request);

  if (rawBody === undefined) {
    sendJson(
      response,
      400,
      {
        ok: false,
        refused: true,
        reason: 'invalid_request',
        message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
      },
      cors,
    );
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    const body = refusal('invalid_request', 'Body must be JSON.');
    rememberOutcome(runtime, principal, url.pathname, false, body);
    sendJson(response, 400, body, cors);
    return;
  }

  const confirmed = isRecord(parsed) && parsed.confirmed === true;

  if (url.pathname === PLAN_PATH) {
    const result = await proposeAct(parsed, runtime.client, runtime.llm, {
      boundWorkspaceId: runtime.boundWorkspaceId,
      proposals: runtime.proposals,
      memberId: principal.memberId,
      actorMemberId: principal.memberId,
    });
    rememberOutcome(runtime, principal, PLAN_PATH, confirmed, result);
    sendJson(response, statusFor(result), result, cors);
    return;
  }

  const idempotencyKey = readIdempotencyKey(headerValue(request.headers['idempotency-key']));

  if (idempotencyKey === 'invalid') {
    const body = refusal(
      'invalid_request',
      'Idempotency-Key must be 8–200 characters of letters, numbers, dot, colon, underscore, or hyphen.',
    );
    rememberOutcome(runtime, principal, url.pathname, confirmed, body);
    sendJson(response, 400, body, cors);
    return;
  }

  const execute = async () => {
    const result =
      url.pathname === UNDO_PATH
        ? await executeConfirmedUndo(parsed, runtime, principal)
        : await executeConfirmedAct(parsed, runtime, principal);
    return { status: statusFor(result), body: result };
  };

  if (!idempotencyKey) {
    const result = await execute();
    rememberOutcome(runtime, principal, url.pathname, confirmed, result.body);
    sendJson(response, result.status, result.body, cors);
    return;
  }

  const stored = await runtime.idempotency.run(principal.memberId, idempotencyKey, rawBody, execute);

  if ('conflict' in stored && stored.conflict) {
    const body = refusal(
      'idempotency_conflict',
      'This idempotency key was already used with a different request body.',
    );
    rememberOutcome(runtime, principal, url.pathname, confirmed, body);
    sendJson(response, 409, body, cors);
    return;
  }

  if ('full' in stored && stored.full) {
    const body = refusal(
      'invalid_request',
      'The idempotency store is full. New keys are refused so an evicted key cannot run a write twice.',
    );
    rememberOutcome(runtime, principal, url.pathname, confirmed, body);
    sendJson(response, 503, body, cors);
    return;
  }

  if (!('response' in stored)) {
    return;
  }

  rememberOutcome(runtime, principal, url.pathname, confirmed, stored.response.body, stored.replayed);
  sendJson(response, stored.response.status, stored.response.body, {
    ...cors,
    ...(stored.replayed ? { 'idempotency-replayed': 'true' } : {}),
  });
}

async function executeConfirmedAct(
  body: unknown,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
): Promise<ActResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  if (runtime.boundWorkspaceId && parsed.workspaceId !== runtime.boundWorkspaceId) {
    return refusal(
      'cross_workspace',
      `Request workspace "${parsed.workspaceId}" does not match the gateway workspace "${runtime.boundWorkspaceId}".`,
    );
  }

  if (!parsed.confirmed || !parsed.proposalId) {
    return refusal(
      'confirmation_required',
      'Nothing is written until Confirm. POST /v1/ai/plan returns a preview id; POST /v1/ai/act must send that id with confirmed true. Cancel sends nothing.',
    );
  }

  const claimed = runtime.proposals.claim(
    parsed.proposalId,
    parsed.workspaceId,
    principal.memberId,
    parsed.choiceId,
  );

  if (!claimed.ok) {
    if (claimed.reason === 'workspace') {
      return refusal('cross_workspace', 'This preview belongs to a different workspace.');
    }

    if (claimed.reason === 'choice') {
      return refusal(
        'confirmation_required',
        'Choose one of the matching records, then confirm. Nothing was written.',
      );
    }

    return refusal(
      'confirmation_required',
      'This preview expired, was already confirmed, or does not exist. Propose it again.',
    );
  }

  const executed = await executeAct(
    {
      workspaceId: parsed.workspaceId,
      confirmed: true,
      tools: claimed.proposal.tools,
    },
    runtime.client,
    { boundWorkspaceId: runtime.boundWorkspaceId },
  );

  if (!executed.ok) {
    return executed;
  }

  const { effects, ...publicResult } = executed;

  if (!effects || effects.length === 0) {
    return publicResult;
  }

  const ticket = runtime.undos.save(principal.memberId, parsed.workspaceId, effects);

  if (!ticket) {
    return publicResult;
  }

  return { ...publicResult, undo: { id: ticket.id, summary: ticket.summary } };
}

async function executeConfirmedUndo(
  body: unknown,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
): Promise<ActResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  if (runtime.boundWorkspaceId && parsed.workspaceId !== runtime.boundWorkspaceId) {
    return refusal(
      'cross_workspace',
      `Request workspace "${parsed.workspaceId}" does not match the gateway workspace "${runtime.boundWorkspaceId}".`,
    );
  }

  if (!parsed.confirmed || !parsed.undoId) {
    return refusal(
      'confirmation_required',
      'Nothing is reversed until Undo sends the last undo id with confirmed true.',
    );
  }

  const begun = runtime.undos.begin(parsed.undoId, principal.memberId, parsed.workspaceId);

  if (!begun.ok) {
    if (begun.reason === 'workspace') {
      return refusal('cross_workspace', 'This undo belongs to a different workspace.');
    }

    if (begun.reason === 'busy') {
      return refusal('confirmation_required', 'Undo is already running for this change.');
    }

    return refusal('not_found', 'There is no matching undo for the last confirmed change.');
  }

  const permission = assertCanUndo(begun.ticket.effects, await loadAudience(runtime.client));

  if (permission) {
    runtime.undos.release(principal.memberId);
    return permission;
  }

  let failures;

  try {
    failures = await compensate(runtime.client, parsed.workspaceId, begun.ticket.effects);
  } catch (error) {
    runtime.undos.release(principal.memberId);
    return upstreamFailure(error, 0);
  }

  if (failures.length > 0) {
    const failedIndexes = new Set(failures.map((failure) => failure.index));
    const remaining = begun.ticket.effects.filter((_effect, index) => failedIndexes.has(index));

    if (remaining.length < begun.ticket.effects.length) {
      runtime.undos.retain(parsed.undoId, principal.memberId, parsed.workspaceId, remaining);
    }

    runtime.undos.release(principal.memberId);

    if (failures.every((failure) => failure.reason === 'conflict')) {
      const nothingReversed = failures.length === begun.ticket.effects.length;

      return refusal(
        'precondition_failed',
        nothingReversed
          ? 'The record changed after that action, so nothing was reversed. Undo is still available.'
          : 'Some changes were reversed. The ones that changed since then are still available to undo.',
      );
    }

    return partialFailure(
      'Undo could not reverse every change. The remaining changes are still available to undo.',
      failures.map((failure) => failure.id),
    );
  }

  runtime.undos.finish(principal.memberId);

  return {
    ok: true,
    workspaceId: parsed.workspaceId,
    results: [],
    summary: 'Reversed the last confirmed change.',
  };
}

function rememberOutcome(
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  path: string,
  confirmed: boolean,
  body: unknown,
  replayed = false,
): void {
  const action = actionForPath(path);

  if (!isRecord(body)) {
    remember(runtime, {
      memberId: principal.memberId,
      actor: principal.actor,
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
    (typeof body.summary === 'string' ? body.summary : undefined) ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (ok ? `${action} completed` : 'Request failed');

  remember(runtime, {
    memberId: principal.memberId,
    actor: principal.actor,
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

function actionForPath(pathname: string): AuditAction {
  if (pathname === PLAN_PATH) {
    return 'plan';
  }

  if (pathname === TOOLS_PATH) {
    return 'tools';
  }

  if (pathname === AUDIT_PATH) {
    return 'audit';
  }

  if (pathname === UNDO_PATH) {
    return 'undo';
  }

  return 'act';
}

function statusFor(result: ActResult | PlanResult): number {
  if (result.ok) {
    return 200;
  }

  if (result.reason === 'upstream_error') {
    return 502;
  }

  if (result.reason === 'partial_failure') {
    return 409;
  }

  if (!('refused' in result) || !result.refused) {
    return 400;
  }

  if (result.reason === 'unauthorized') {
    return 401;
  }

  if (result.reason === 'forbidden') {
    return 403;
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

function corsFor(request: IncomingMessage, runtime: GatewayRuntime): Record<string, string> {
  return corsHeadersFor(headerValue(request.headers.origin), runtime.allowedOrigins);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
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
