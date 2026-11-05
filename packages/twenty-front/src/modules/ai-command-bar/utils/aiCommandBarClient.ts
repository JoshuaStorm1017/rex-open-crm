import { isPlainObject } from 'twenty-shared/utils';

import { type AiCommandBarConfig } from '@/ai-command-bar/utils/readAiCommandBarConfig';

export type AiProposalLine = {
  tool: string;
  summary: string;
};

export type AiProposal = {
  id: string;
  summary: string;
  tools: unknown[];
  lines: AiProposalLine[];
};

export type AiRecordLink = {
  id: string;
  objectName: string;
  label: string;
};

export type AiCommandOutcome<TData> =
  | { kind: 'data'; data: TData }
  | { kind: 'message'; message: string };

type FetchImpl = typeof fetch;

export const proposeAiCommand = async (
  config: AiCommandBarConfig,
  intent: string,
  fetchImpl: FetchImpl,
): Promise<AiCommandOutcome<AiProposal>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/plan',
    { workspaceId: config.workspaceId, intent },
    fetchImpl,
  );

  if (payload.kind === 'message') {
    return payload;
  }

  const proposal = readProposal(payload.data);

  if (!proposal) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected plan.',
    };
  }

  return { kind: 'data', data: proposal };
};

export const executeAiCommand = async (
  config: AiCommandBarConfig,
  proposalId: string,
  idempotencyKey: string,
  fetchImpl: FetchImpl,
): Promise<AiCommandOutcome<AiRecordLink[]>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/act',
    { workspaceId: config.workspaceId, confirmed: true, proposalId },
    fetchImpl,
    idempotencyKey,
  );

  if (payload.kind === 'message') {
    return payload;
  }

  return { kind: 'data', data: readRecordLinks(payload.data) };
};

const postAiCommand = async (
  config: AiCommandBarConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl,
  idempotencyKey?: string,
): Promise<AiCommandOutcome<unknown>> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-rex-actor': config.actor,
  };

  if (config.bearerToken) {
    headers.authorization = `Bearer ${config.bearerToken}`;
  }

  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }

  let response: Response;

  try {
    response = await fetchImpl(`${config.gatewayUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: 'message',
      message: 'The AI gateway is unreachable.',
    };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected response.',
    };
  }

  if (!isPlainObject(payload) || payload.ok !== true) {
    return {
      kind: 'message',
      message: readMessage(payload),
    };
  }

  return { kind: 'data', data: payload };
};

const readProposal = (payload: unknown): AiProposal | undefined => {
  if (!isPlainObject(payload) || !isPlainObject(payload.proposal)) {
    return undefined;
  }

  const { id, summary, tools, lines } = payload.proposal;

  if (
    typeof id !== 'string' ||
    !/^proposal_[0-9a-f-]{36}$/.test(id) ||
    typeof summary !== 'string' ||
    !Array.isArray(tools) ||
    !Array.isArray(lines)
  ) {
    return undefined;
  }

  if (tools.length === 0 || lines.length === 0) {
    return undefined;
  }

  const parsedLines: AiProposalLine[] = [];

  for (const line of lines) {
    if (
      !isPlainObject(line) ||
      typeof line.tool !== 'string' ||
      typeof line.summary !== 'string'
    ) {
      return undefined;
    }

    parsedLines.push({ tool: line.tool, summary: line.summary });
  }

  return { id, summary, tools, lines: parsedLines };
};

const readRecordLinks = (payload: unknown): AiRecordLink[] => {
  if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
    return [];
  }

  const links: AiRecordLink[] = [];

  for (const result of payload.results) {
    if (!isPlainObject(result)) {
      continue;
    }

    pushRecord(links, result.record);

    if (Array.isArray(result.records)) {
      for (const record of result.records) {
        pushRecord(links, record);
      }
    }
  }

  return links;
};

const pushRecord = (links: AiRecordLink[], record: unknown): void => {
  if (
    !isPlainObject(record) ||
    typeof record.id !== 'string' ||
    typeof record.objectName !== 'string'
  ) {
    return;
  }

  links.push({
    id: record.id,
    objectName: record.objectName,
    label:
      typeof record.label === 'string' && record.label.length > 0
        ? record.label
        : record.id,
  });
};

const readMessage = (payload: unknown): string => {
  if (
    isPlainObject(payload) &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  ) {
    return payload.message;
  }

  return 'The AI gateway refused this request.';
};
