import { isPlainObject } from 'twenty-shared/utils';

import { type AiCommandBarConfig } from '@/ai-command-bar/utils/readAiCommandBarConfig';

export type AiProposalLine = {
  tool: string;
  summary: string;
};

export type AiProposalCandidate = {
  id: string;
  label: string;
  objectName: string;
  action?: 'use' | 'create';
  detail?: string;
};

export type AiProposalChoiceGroup = {
  id: string;
  prompt: string;
  candidates: AiProposalCandidate[];
};

export type AiProposalChoice = {
  prompt: string;
  candidates: AiProposalCandidate[];
  groups?: AiProposalChoiceGroup[];
};

export type AiProposal = {
  id: string;
  summary: string;
  tools: unknown[];
  lines: AiProposalLine[];
  choice?: AiProposalChoice;
};

export type AiRecordLink = {
  id: string;
  objectName: string;
  label: string;
};

export type AiOpenRecord = {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
};

export type AiUndo = {
  id: string;
  summary: string;
};

export type AiActResult = {
  links: AiRecordLink[];
  undo?: AiUndo;
  undos?: AiUndo[];
};

export type AiUndoResult = {
  next?: AiUndo;
  undos?: AiUndo[];
};

export type AiCommandOutcome<TData> =
  | { kind: 'data'; data: TData }
  | { kind: 'message'; message: string };

type FetchImpl = typeof fetch;

export const proposeAiCommand = async (
  config: AiCommandBarConfig,
  intent: string,
  fetchImpl: FetchImpl,
  openRecord?: AiOpenRecord,
  onPartial?: (lines: AiProposalLine[]) => void,
): Promise<AiCommandOutcome<AiProposal>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/plan',
    {
      workspaceId: config.workspaceId,
      intent,
      ...(openRecord ? { context: openRecord } : {}),
    },
    fetchImpl,
    undefined,
    onPartial,
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
  choiceId?: string,
  choices?: Record<string, string>,
): Promise<AiCommandOutcome<AiActResult>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/act',
    {
      workspaceId: config.workspaceId,
      confirmed: true,
      proposalId,
      ...(choiceId ? { choiceId } : {}),
      ...(choices && Object.keys(choices).length > 0 ? { choices } : {}),
    },
    fetchImpl,
    idempotencyKey,
  );

  if (payload.kind === 'message') {
    return payload;
  }

  const undo = readUndo(payload.data);
  const undos = readUndos(payload.data);

  return {
    kind: 'data',
    data: {
      links: readRecordLinks(payload.data),
      ...(undo ? { undo } : {}),
      ...(undos ? { undos } : {}),
    },
  };
};

export const undoAiCommand = async (
  config: AiCommandBarConfig,
  undoId: string,
  idempotencyKey: string,
  fetchImpl: FetchImpl,
): Promise<AiCommandOutcome<AiUndoResult>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/undo',
    {
      workspaceId: config.workspaceId,
      confirmed: true,
      undoId,
    },
    fetchImpl,
    idempotencyKey,
  );

  if (payload.kind === 'message') {
    return payload;
  }

  const next = readUndo(payload.data);
  const undos = readUndos(payload.data);

  return {
    kind: 'data',
    data: {
      ...(next ? { next } : {}),
      ...(undos ? { undos } : {}),
    },
  };
};

const postAiCommand = async (
  config: AiCommandBarConfig,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl,
  idempotencyKey?: string,
  onPartial?: (lines: AiProposalLine[]) => void,
): Promise<AiCommandOutcome<unknown>> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (onPartial) {
    headers.accept = 'text/event-stream';
  }

  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }

  let response: Response;

  try {
    response = await fetchImpl(`${config.gatewayUrl}${path}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: 'message',
      message: 'The AI gateway is unreachable.',
    };
  }

  const contentType =
    typeof response.headers?.get === 'function'
      ? (response.headers.get('content-type') ?? '')
      : '';

  if (contentType.includes('text/event-stream')) {
    return readPlanStream(response, onPartial);
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

const readPlanStream = async (
  response: Response,
  onPartial?: (lines: AiProposalLine[]) => void,
): Promise<AiCommandOutcome<unknown>> => {
  const body = response.body;

  if (!body) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an empty preview.',
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let proposal: unknown;
  let failure: string | undefined;

  while (true) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const event = readSseEvent(part);

      if (!event) {
        continue;
      }

      if (event.name === 'partial') {
        const lines = readPartialLines(event.data);

        if (lines && onPartial) {
          onPartial(lines);
        }

        continue;
      }

      if (event.name === 'proposal') {
        proposal = event.data;
        continue;
      }

      if (event.name === 'error') {
        failure = readMessage(event.data);
      }
    }
  }

  if (proposal !== undefined) {
    return { kind: 'data', data: proposal };
  }

  return {
    kind: 'message',
    message: failure ?? 'The preview ended before it could be confirmed.',
  };
};

const readSseEvent = (
  chunk: string,
): { name: string; data: unknown } | undefined => {
  let name = 'message';
  const dataLines: string[] = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice('event:'.length).trim();
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  try {
    return { name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return undefined;
  }
};

const readPartialLines = (payload: unknown): AiProposalLine[] | undefined => {
  if (!isPlainObject(payload) || !Array.isArray(payload.lines)) {
    return undefined;
  }

  const lines: AiProposalLine[] = [];

  for (const line of payload.lines) {
    if (
      !isPlainObject(line) ||
      typeof line.tool !== 'string' ||
      typeof line.summary !== 'string'
    ) {
      return undefined;
    }

    lines.push({ tool: line.tool, summary: line.summary });
  }

  return lines;
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

  const choice = readChoice(payload.proposal.choice);

  if (tools.length === 0 && !choice) {
    return undefined;
  }

  if (lines.length === 0 && !choice?.groups) {
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

  return {
    id,
    summary,
    tools,
    lines: parsedLines,
    ...(choice ? { choice } : {}),
  };
};

const readChoice = (value: unknown): AiProposalChoice | undefined => {
  if (!isPlainObject(value) || typeof value.prompt !== 'string') {
    return undefined;
  }

  const groups = readChoiceGroups(value.groups);

  if (Array.isArray(value.groups) && !groups) {
    return undefined;
  }

  const candidates = readCandidates(value.candidates);

  if (!groups && (!candidates || candidates.length < 2)) {
    return undefined;
  }

  if (groups && groups.length === 0) {
    return undefined;
  }

  return {
    prompt: value.prompt,
    candidates: candidates ?? groups?.[0]?.candidates ?? [],
    ...(groups ? { groups } : {}),
  };
};

const readChoiceGroups = (
  value: unknown,
): AiProposalChoiceGroup[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const groups: AiProposalChoiceGroup[] = [];

  for (const group of value) {
    if (
      !isPlainObject(group) ||
      typeof group.id !== 'string' ||
      typeof group.prompt !== 'string'
    ) {
      return undefined;
    }

    const candidates = readCandidates(group.candidates);

    if (!candidates || candidates.length < 2) {
      return undefined;
    }

    groups.push({ id: group.id, prompt: group.prompt, candidates });
  }

  return groups;
};

const readCandidates = (value: unknown): AiProposalCandidate[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const candidates: AiProposalCandidate[] = [];

  for (const candidate of value) {
    if (
      !isPlainObject(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.label !== 'string' ||
      typeof candidate.objectName !== 'string'
    ) {
      return undefined;
    }

    candidates.push({
      id: candidate.id,
      label: candidate.label,
      objectName: candidate.objectName,
      ...(candidate.action === 'create' || candidate.action === 'use'
        ? { action: candidate.action }
        : {}),
      ...(typeof candidate.detail === 'string' && candidate.detail.length > 0
        ? { detail: candidate.detail }
        : {}),
    });
  }

  return candidates;
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

const UNDO_ID_PATTERN = /^undo_[0-9a-f-]{36}$/;

const readUndo = (payload: unknown): AiUndo | undefined => {
  if (!isPlainObject(payload) || !isPlainObject(payload.undo)) {
    return undefined;
  }

  const { id, summary } = payload.undo;

  if (
    typeof id !== 'string' ||
    !UNDO_ID_PATTERN.test(id) ||
    typeof summary !== 'string' ||
    summary.trim().length === 0
  ) {
    return undefined;
  }

  return { id, summary };
};

const readUndos = (payload: unknown): AiUndo[] | undefined => {
  if (!isPlainObject(payload) || !Array.isArray(payload.undos)) {
    return undefined;
  }

  const undos: AiUndo[] = [];

  for (const undo of payload.undos) {
    if (
      !isPlainObject(undo) ||
      typeof undo.id !== 'string' ||
      !UNDO_ID_PATTERN.test(undo.id) ||
      typeof undo.summary !== 'string' ||
      undo.summary.trim().length === 0
    ) {
      return undefined;
    }

    undos.push({ id: undo.id, summary: undo.summary });
  }

  return undos.length > 0 ? undos : undefined;
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
