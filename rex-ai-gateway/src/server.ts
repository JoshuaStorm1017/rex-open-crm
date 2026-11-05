import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { compensate, partialFailure } from './act/compensate';
import { describePartialTools } from './act/describe-tool';
import {
  executeAct,
  type ExecuteActOptions,
  type SettledToolEvent,
} from './act/execute-act';
import { parseGatewayRequest } from './act/parse-request';
import {
  assertCanUndo,
  catalogForAudience,
  loadAudience,
} from './act/permissions';
import { findStaleChanges } from './act/live-etag';
import { WORKSPACE_ID_PATTERN } from './act/find-foreign-workspace-id';
import { proposeAct, reproposeAct } from './act/propose-act';
import { withoutLiveEtag } from './act/strip-live-etag';
import { isRecord } from './is-record';
import {
  refusal,
  upstreamFailure,
  type ActRefusal,
  type ActResult,
  type PlanResult,
} from './act/types';
import {
  createMockAuthenticator,
  type Authenticator,
} from './auth/authenticate';
import { withMemberCredential } from './auth/call-context';
import type { MemberPrincipal } from './auth/types';
import { AuditLog, type AuditAction, type AuditEntry } from './audit/audit-log';
import { corsHeadersFor, DEFAULT_ALLOWED_ORIGINS } from './http/cors';
import { IdempotencyStore, readIdempotencyKey } from './http/idempotency-store';
import { ProposalStore } from './http/proposal-store';
import { SkillStore } from './http/skill-store';
import { UndoStore } from './http/undo-store';
import { createMockLlmProvider } from './llm/mock-llm-provider';
import type { LlmProvider } from './llm/llm-provider';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const ACT_PATH = '/v1/ai/act';
const PLAN_PATH = '/v1/ai/plan';
const UNDO_PATH = '/v1/ai/undo';
const TOOLS_PATH = '/v1/ai/tools';
const AUDIT_PATH = '/v1/ai/audit';
const SKILLS_PATH = '/v1/ai/skills';
const REPROPOSE_PATH = '/v1/ai/repropose';
const KNOWN_PATHS = new Set([
  ACT_PATH,
  PLAN_PATH,
  UNDO_PATH,
  TOOLS_PATH,
  AUDIT_PATH,
  SKILLS_PATH,
  REPROPOSE_PATH,
]);
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
  skills?: SkillStore;
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
  skills: SkillStore;
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
    skills: options.skills ?? new SkillStore(),
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

      console.error(
        error instanceof Error ? error.message : 'Unexpected error',
      );
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
    sendJson(
      response,
      200,
      { ok: true, entries: runtime.audit.list(principal.memberId) },
      cors,
    );
    return;
  }

  if (request.method === 'GET' && url.pathname === SKILLS_PATH) {
    listSkills(url, response, runtime, principal, cors);
    return;
  }

  if (request.method === 'POST' && url.pathname === REPROPOSE_PATH) {
    await postRepropose(request, response, runtime, principal, cors);
    return;
  }

  if (request.method === 'POST' && url.pathname === SKILLS_PATH) {
    await postSkill(request, response, runtime, principal, cors);
    return;
  }

  if (
    request.method !== 'POST' ||
    (url.pathname !== ACT_PATH &&
      url.pathname !== PLAN_PATH &&
      url.pathname !== UNDO_PATH)
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
    if (wantsEventStream(request)) {
      await streamPlan(parsed, response, runtime, principal, cors);
      return;
    }

    const result = await proposeAct(parsed, runtime.client, runtime.llm, {
      boundWorkspaceId: runtime.boundWorkspaceId,
      proposals: runtime.proposals,
      skills: runtime.skills,
      memberId: principal.memberId,
      actorMemberId: principal.memberId,
    });
    rememberOutcome(runtime, principal, PLAN_PATH, confirmed, result);
    sendJson(response, statusFor(result), result, cors);
    return;
  }

  const idempotencyKey = readIdempotencyKey(
    headerValue(request.headers['idempotency-key']),
  );

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

  if (url.pathname === ACT_PATH && wantsEventStream(request)) {
    await streamAct(
      parsed,
      rawBody,
      response,
      runtime,
      principal,
      cors,
      idempotencyKey,
    );
    return;
  }

  if (!idempotencyKey) {
    const result = await execute();
    const entry = rememberOutcome(
      runtime,
      principal,
      url.pathname,
      confirmed,
      result.body,
    );
    linkUndoToAct(runtime, principal.memberId, result.body, entry, false);
    sendJson(response, result.status, result.body, cors);
    return;
  }

  const stored = await runtime.idempotency.run(
    principal.memberId,
    idempotencyKey,
    rawBody,
    execute,
  );

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

  const entry = rememberOutcome(
    runtime,
    principal,
    url.pathname,
    confirmed,
    stored.response.body,
    stored.replayed,
  );
  linkUndoToAct(
    runtime,
    principal.memberId,
    stored.response.body,
    entry,
    stored.replayed,
  );
  sendJson(response, stored.response.status, stored.response.body, {
    ...cors,
    ...(stored.replayed ? { 'idempotency-replayed': 'true' } : {}),
  });
}

async function streamAct(
  body: unknown,
  rawBody: string,
  response: ServerResponse,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  cors: Record<string, string>,
  idempotencyKey: string | undefined,
): Promise<void> {
  response.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const confirmed = isRecord(body) && body.confirmed === true;
  const execute = async () => {
    const result = await executeConfirmedAct(
      body,
      runtime,
      principal,
      (event) => {
        writeEvent(response, 'progress', progressPayload(event));
      },
    );

    return { status: statusFor(result), body: result };
  };

  const finish = (payload: unknown, replayed: boolean) => {
    const entry = rememberOutcome(
      runtime,
      principal,
      ACT_PATH,
      confirmed,
      payload,
      replayed,
    );
    linkUndoToAct(runtime, principal.memberId, payload, entry, replayed);
    const event = isRecord(payload) && payload.ok === true ? 'result' : 'error';
    writeEvent(response, event, payload);
    response.end();
  };

  if (!idempotencyKey) {
    const result = await execute();
    finish(result.body, false);
    return;
  }

  const stored = await runtime.idempotency.run(
    principal.memberId,
    idempotencyKey,
    rawBody,
    execute,
  );

  if ('conflict' in stored && stored.conflict) {
    finish(
      refusal(
        'idempotency_conflict',
        'This idempotency key was already used with a different request body.',
      ),
      false,
    );
    return;
  }

  if ('full' in stored && stored.full) {
    finish(
      refusal(
        'invalid_request',
        'The idempotency store is full. New keys are refused so an evicted key cannot run a write twice.',
      ),
      false,
    );
    return;
  }

  if (!('response' in stored)) {
    response.end();
    return;
  }

  finish(stored.response.body, stored.replayed);
}

function progressPayload(event: SettledToolEvent): Record<string, unknown> {
  const record =
    event.result.status === 'found' ? undefined : event.result.record;

  return {
    index: event.index,
    total: event.total,
    tool: event.result.tool,
    status: event.result.status,
    ...(record
      ? { id: record.id, objectName: record.objectName, label: record.label }
      : {}),
  };
}

function claimRefusal(
  reason: 'missing' | 'expired' | 'workspace' | 'choice',
): ActResult {
  if (reason === 'workspace') {
    return refusal(
      'cross_workspace',
      'This preview belongs to a different workspace.',
    );
  }

  if (reason === 'choice') {
    return refusal(
      'confirmation_required',
      'Choose a record for each name, then confirm. Nothing was written.',
    );
  }

  return refusal(
    'confirmation_required',
    'This preview expired, was already confirmed, or does not exist. Propose it again.',
  );
}

async function executeConfirmedAct(
  body: unknown,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  onSettled?: (event: SettledToolEvent) => void,
): Promise<ActResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  if (
    runtime.boundWorkspaceId &&
    parsed.workspaceId !== runtime.boundWorkspaceId
  ) {
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

  const peeked = runtime.proposals.peek(
    parsed.proposalId,
    parsed.workspaceId,
    principal.memberId,
    parsed.choiceId,
    parsed.choices,
  );

  if (!peeked.ok) {
    return claimRefusal(peeked.reason);
  }

  const live = await findStaleChanges(
    runtime.client,
    parsed.workspaceId,
    peeked.proposal.tools,
  );

  if (!live.ok) {
    return live.failure;
  }

  const claimed = runtime.proposals.claim(
    parsed.proposalId,
    parsed.workspaceId,
    principal.memberId,
    parsed.choiceId,
    parsed.choices,
  );

  if (!claimed.ok) {
    return claimRefusal(claimed.reason);
  }

  const executed = await executeAct(
    {
      workspaceId: parsed.workspaceId,
      confirmed: true,
      tools: claimed.proposal.tools,
    },
    runtime.client,
    {
      boundWorkspaceId: runtime.boundWorkspaceId,
      ...(onSettled ? { onSettled } : {}),
    },
  );

  if (!executed.ok) {
    return executed;
  }

  const { effects, ...publicResult } = executed;
  const confirmedPlan = runtime.skills.saveConfirmed(
    principal.memberId,
    parsed.workspaceId,
    withoutLiveEtag(claimed.proposal.tools),
  );
  const withPlan = confirmedPlan
    ? { ...publicResult, confirmedPlanId: confirmedPlan.id }
    : publicResult;

  if (!effects || effects.length === 0) {
    return withPlan;
  }

  const ticket = runtime.undos.save(
    principal.memberId,
    parsed.workspaceId,
    effects,
  );

  if (!ticket) {
    return withPlan;
  }

  return {
    ...withPlan,
    undo: { id: ticket.id, summary: ticket.summary },
    undos: publicUndos(runtime, principal.memberId, parsed.workspaceId),
  };
}

function listSkills(
  url: URL,
  response: ServerResponse,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  cors: Record<string, string>,
): void {
  const workspaceId = url.searchParams.get('workspaceId') ?? '';

  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    sendJson(
      response,
      400,
      refusal(
        'invalid_request',
        'workspaceId must be a gateway token such as "ws_demo".',
      ),
      cors,
    );
    return;
  }

  if (runtime.boundWorkspaceId && workspaceId !== runtime.boundWorkspaceId) {
    sendJson(
      response,
      400,
      refusal(
        'cross_workspace',
        `Request workspace "${workspaceId}" does not match the gateway workspace "${runtime.boundWorkspaceId}".`,
      ),
      cors,
    );
    return;
  }

  sendJson(
    response,
    200,
    {
      ok: true,
      workspaceId,
      skills: runtime.skills.list(principal.memberId, workspaceId),
    },
    cors,
  );
}

async function postRepropose(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  cors: Record<string, string>,
): Promise<void> {
  const parsed = await readJsonBody(request, response, cors);

  if (parsed === undefined) {
    return;
  }

  const result = await reproposeAct(parsed, runtime.client, {
    boundWorkspaceId: runtime.boundWorkspaceId,
    proposals: runtime.proposals,
    memberId: principal.memberId,
    actorMemberId: principal.memberId,
  });
  rememberOutcome(runtime, principal, REPROPOSE_PATH, false, result);
  sendJson(response, statusFor(result), result, cors);
}

async function postSkill(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  cors: Record<string, string>,
): Promise<void> {
  const parsedBody = await readJsonBody(request, response, cors);

  if (parsedBody === undefined) {
    return;
  }

  const parsed = parseGatewayRequest(parsedBody);

  if ('refused' in parsed) {
    rememberOutcome(runtime, principal, SKILLS_PATH, false, parsed);
    sendJson(response, statusFor(parsed), parsed, cors);
    return;
  }

  if (
    runtime.boundWorkspaceId &&
    parsed.workspaceId !== runtime.boundWorkspaceId
  ) {
    const body = refusal(
      'cross_workspace',
      `Request workspace "${parsed.workspaceId}" does not match the gateway workspace "${runtime.boundWorkspaceId}".`,
    );
    rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
    sendJson(response, statusFor(body), body, cors);
    return;
  }

  if (!parsed.confirmedPlanId || !parsed.skillName) {
    const body = refusal(
      'invalid_request',
      'Saving a skill needs confirmedPlanId and skillName. Nothing was written.',
    );
    rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
    sendJson(response, statusFor(body), body, cors);
    return;
  }

  const plan = runtime.skills.readConfirmed(
    parsed.confirmedPlanId,
    principal.memberId,
  );

  if (!plan) {
    const body = refusal(
      'not_found',
      'That confirmed plan expired or does not exist. Nothing was written.',
    );
    rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
    sendJson(response, statusFor(body), body, cors);
    return;
  }

  if (plan.workspaceId !== parsed.workspaceId) {
    const body = refusal(
      'cross_workspace',
      'This confirmed plan belongs to a different workspace.',
    );
    rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
    sendJson(response, statusFor(body), body, cors);
    return;
  }

  const saved = runtime.skills.saveSkill(
    principal.memberId,
    parsed.workspaceId,
    parsed.skillName,
    plan.tools,
  );

  if (!saved.ok) {
    const body = refusal(
      'invalid_request',
      saved.reason === 'duplicate'
        ? 'A skill with that name is already saved.'
        : saved.reason === 'full'
          ? 'Too many saved skills. Nothing was written.'
          : 'That confirmed plan has no tools to save.',
    );
    rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
    sendJson(response, statusFor(body), body, cors);
    return;
  }

  const body = {
    ok: true as const,
    workspaceId: parsed.workspaceId,
    summary: `Saved skill ${saved.skill.name}.`,
    skill: {
      id: saved.skill.id,
      name: saved.skill.name,
      tools: saved.skill.tools.map((tool) => tool.name),
    },
  };
  rememberOutcome(runtime, principal, SKILLS_PATH, false, body);
  sendJson(response, 200, body, cors);
}

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  cors: Record<string, string>,
): Promise<unknown | undefined> {
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
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const body = refusal('invalid_request', 'Body must be JSON.');
    sendJson(response, 400, body, cors);
    return undefined;
  }
}

function undoLockLost(): ActRefusal {
  return refusal(
    'precondition_failed',
    'Another process took this undo. This process stopped and left the ticket in place.',
  );
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

  if (
    runtime.boundWorkspaceId &&
    parsed.workspaceId !== runtime.boundWorkspaceId
  ) {
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

  const begun = runtime.undos.begin(
    parsed.undoId,
    principal.memberId,
    parsed.workspaceId,
  );

  if (!begun.ok) {
    if (begun.reason === 'workspace') {
      return refusal(
        'cross_workspace',
        'This undo belongs to a different workspace.',
      );
    }

    if (begun.reason === 'busy') {
      return refusal(
        'confirmation_required',
        'Undo is already running for this change.',
      );
    }

    if (begun.reason === 'order') {
      return refusal(
        'invalid_request',
        'Undo the most recent change before an older one. Nothing was reversed.',
      );
    }

    return refusal(
      'not_found',
      'There is no matching undo for the last confirmed change.',
    );
  }

  const permission = assertCanUndo(
    begun.ticket.effects,
    await loadAudience(runtime.client),
  );

  if (permission) {
    runtime.undos.release(principal.memberId);
    return permission;
  }

  if (runtime.undos.superseded(principal.memberId)) {
    runtime.undos.release(principal.memberId);
    return refusal(
      'precondition_failed',
      'A newer change landed before this undo wrote anything. Nothing was reversed. Undo the newest change first.',
    );
  }

  if (!runtime.undos.holdsLock(principal.memberId)) {
    runtime.undos.release(principal.memberId);
    return undoLockLost();
  }

  let failures;

  try {
    failures = await compensate(
      runtime.client,
      parsed.workspaceId,
      begun.ticket.effects,
      () =>
        runtime.undos.holdsLock(principal.memberId) &&
        !runtime.undos.superseded(principal.memberId),
    );
  } catch (error) {
    runtime.undos.release(principal.memberId);
    return upstreamFailure(error, 0);
  }

  if (!runtime.undos.holdsLock(principal.memberId)) {
    runtime.undos.release(principal.memberId);
    return undoLockLost();
  }

  if (failures.some((failure) => failure.reason === 'superseded')) {
    const failedIndexes = new Set(failures.map((failure) => failure.index));
    const remaining = begun.ticket.effects.filter((_effect, index) =>
      failedIndexes.has(index),
    );
    const nothingReversed = remaining.length === begun.ticket.effects.length;

    if (!nothingReversed) {
      runtime.undos.retain(
        parsed.undoId,
        principal.memberId,
        parsed.workspaceId,
        remaining,
      );
    }

    runtime.undos.release(principal.memberId);

    return refusal(
      'precondition_failed',
      nothingReversed
        ? 'A newer change landed before this undo wrote anything. Nothing was reversed. Undo the newest change first.'
        : 'A newer change landed while undo was running. Completed reversals stand. What is left stays available after the newest change is undone.',
    );
  }

  if (failures.length > 0) {
    const failedIndexes = new Set(failures.map((failure) => failure.index));
    const remaining = begun.ticket.effects.filter((_effect, index) =>
      failedIndexes.has(index),
    );

    if (remaining.length < begun.ticket.effects.length) {
      runtime.undos.retain(
        parsed.undoId,
        principal.memberId,
        parsed.workspaceId,
        remaining,
      );
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

  const reversesAuditId = begun.ticket.actAuditId;
  runtime.undos.finish(principal.memberId);
  const undos = publicUndos(runtime, principal.memberId, parsed.workspaceId);

  return {
    ok: true,
    workspaceId: parsed.workspaceId,
    results: [],
    summary: 'Reversed the last confirmed change.',
    ...(reversesAuditId ? { reversesAuditId } : {}),
    ...(undos[0] ? { undo: undos[0], undos } : {}),
  };
}

async function streamPlan(
  parsed: unknown,
  response: ServerResponse,
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  cors: Record<string, string>,
): Promise<void> {
  response.writeHead(200, {
    ...cors,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const workspaceId =
    isRecord(parsed) && typeof parsed.workspaceId === 'string'
      ? parsed.workspaceId
      : 'ws_demo';

  const result = await proposeAct(parsed, runtime.client, runtime.llm, {
    boundWorkspaceId: runtime.boundWorkspaceId,
    proposals: runtime.proposals,
    skills: runtime.skills,
    memberId: principal.memberId,
    actorMemberId: principal.memberId,
    onPartial: (tools) => {
      writeEvent(response, 'partial', {
        partial: true,
        lines: describePartialTools(tools, workspaceId),
      });
    },
  });
  rememberOutcome(runtime, principal, PLAN_PATH, false, result);

  if (result.ok) {
    writeEvent(response, 'proposal', result);
  } else {
    writeEvent(response, 'error', result);
  }

  response.end();
}

function wantsEventStream(request: IncomingMessage): boolean {
  return (headerValue(request.headers.accept) ?? '').includes(
    'text/event-stream',
  );
}

function writeEvent(
  response: ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function publicUndos(
  runtime: GatewayRuntime,
  memberId: string,
  workspaceId: string,
): Array<{ id: string; summary: string }> {
  return runtime.undos.list(memberId, workspaceId).map((ticket) => ({
    id: ticket.id,
    summary: ticket.summary,
  }));
}

function linkUndoToAct(
  runtime: GatewayRuntime,
  memberId: string,
  body: unknown,
  entry: { id: string; action: string; ok: boolean } | undefined,
  replayed: boolean,
): void {
  if (
    replayed ||
    !entry ||
    entry.action !== 'act' ||
    !entry.ok ||
    !isRecord(body) ||
    !isRecord(body.undo)
  ) {
    return;
  }

  if (typeof body.undo.id === 'string') {
    runtime.undos.linkAct(body.undo.id, memberId, entry.id);
  }
}

function rememberOutcome(
  runtime: GatewayRuntime,
  principal: MemberPrincipal,
  path: string,
  confirmed: boolean,
  body: unknown,
  replayed = false,
): ReturnType<AuditLog['record']> | undefined {
  const action = actionForPath(path);

  if (!isRecord(body)) {
    return remember(runtime, {
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
  }

  const workspaceId =
    typeof body.workspaceId === 'string' ? body.workspaceId : undefined;
  const ok = body.ok === true;
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  const tools = ok ? toolNames(body) : [];
  const recordIds = ok ? collectRecordIds(body) : [];
  const summary =
    (isRecord(body.proposal) && typeof body.proposal.summary === 'string'
      ? body.proposal.summary
      : undefined) ??
    (isRecord(body.answer) && typeof body.answer.summary === 'string'
      ? body.answer.summary
      : undefined) ??
    (typeof body.summary === 'string' ? body.summary : undefined) ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (ok ? `${action} completed` : 'Request failed');

  const reverses =
    typeof body.reversesAuditId === 'string' ? body.reversesAuditId : undefined;

  return remember(runtime, {
    memberId: principal.memberId,
    actor: principal.actor,
    action,
    workspaceId,
    summary,
    tools:
      ok && isRecord(body.proposal) ? proposalToolNames(body.proposal) : tools,
    recordIds,
    ok,
    confirmed: action === 'act' ? confirmed : undefined,
    reason,
    replayed,
    ...(reverses ? { reverses } : {}),
  });
}

function proposalToolNames(proposal: Record<string, unknown>): string[] {
  if (!Array.isArray(proposal.tools)) {
    return [];
  }

  return proposal.tools
    .map((tool) =>
      isRecord(tool) && typeof tool.name === 'string' ? tool.name : undefined,
    )
    .filter((name): name is string => name !== undefined);
}

function toolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.results)) {
    return [];
  }

  return body.results
    .map((result) =>
      isRecord(result) && typeof result.tool === 'string'
        ? result.tool
        : undefined,
    )
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
): AuditEntry {
  return runtime.audit.record(entry);
}

function actionForPath(pathname: string): AuditAction {
  if (
    pathname === PLAN_PATH ||
    pathname === REPROPOSE_PATH ||
    pathname === SKILLS_PATH
  ) {
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

function corsFor(
  request: IncomingMessage,
  runtime: GatewayRuntime,
): Record<string, string> {
  return corsHeadersFor(
    headerValue(request.headers.origin),
    runtime.allowedOrigins,
  );
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
