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

export type AiProposalChange = {
  recordId: string;
  objectName: string;
  label: string;
  field?: string;
  metadataField?: string;
  current: string | number | null;
  proposed: string | number | null;
  summary: string;
};

export type AiProposalWarning = {
  code: string;
  message: string;
};

export type AiProposalCreate = {
  objectName: 'person' | 'company';
  label: string;
  summary: string;
};

export type AiProposal = {
  id: string;
  summary: string;
  tools: unknown[];
  lines: AiProposalLine[];
  choice?: AiProposalChoice;
  changes?: AiProposalChange[];
  warnings?: AiProposalWarning[];
  creates?: AiProposalCreate[];
};

export type AiAnswerRecord = {
  id: string;
  objectName: string;
  label: string;
  detail?: string;
};

export type AiAnswer = {
  summary: string;
  records: AiAnswerRecord[];
};

export type AiSkillParameter = {
  name: string;
  label: string;
};

export type AiPlanView = {
  proposal?: AiProposal;
  answer?: AiAnswer;
  parameters?: AiSkillParameter[];
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
  confirmedPlanId?: string;
};

export type AiSkill = {
  id: string;
  name: string;
  tools: string[];
  parameters?: string[];
};

export type AiCaptureImage = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
};

export type AiCaptureSource = 'card' | 'voice';

export type AiUndoResult = {
  next?: AiUndo;
  undos?: AiUndo[];
};

export type AiCommandOutcome<TData> =
  | { kind: 'data'; data: TData }
  | { kind: 'message'; message: string }
  | { kind: 'stale'; message: string; changes: AiProposalChange[] };

type FetchImpl = typeof fetch;

export const proposeAiCommand = async (
  config: AiCommandBarConfig,
  intent: string,
  fetchImpl: FetchImpl,
  openRecord?: AiOpenRecord,
  onPartial?: (lines: AiProposalLine[]) => void,
  onRead?: (records: AiAnswerRecord[]) => void,
): Promise<AiCommandOutcome<AiPlanView>> => {
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
    undefined,
    onRead,
  );

  if (payload.kind !== 'data') {
    return payload.kind === 'message'
      ? payload
      : { kind: 'message', message: payload.message };
  }

  const view = readPlan(payload.data);

  if (!view) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected plan.',
    };
  }

  return { kind: 'data', data: view };
};

export const executeAiCommand = async (
  config: AiCommandBarConfig,
  proposalId: string,
  idempotencyKey: string,
  fetchImpl: FetchImpl,
  choiceId?: string,
  choices?: Record<string, string>,
  onProgress?: (message: string) => void,
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
    undefined,
    onProgress,
  );

  if (payload.kind === 'message' || payload.kind === 'stale') {
    return payload;
  }

  const undo = readUndo(payload.data);
  const undos = readUndos(payload.data);
  const confirmedPlanId = readConfirmedPlanId(payload.data);

  return {
    kind: 'data',
    data: {
      links: readRecordLinks(payload.data),
      ...(undo ? { undo } : {}),
      ...(undos ? { undos } : {}),
      ...(confirmedPlanId ? { confirmedPlanId } : {}),
    },
  };
};

export const reproposeAiCommand = async (
  config: AiCommandBarConfig,
  proposalId: string,
  fetchImpl: FetchImpl,
  choiceId?: string,
  choices?: Record<string, string>,
): Promise<AiCommandOutcome<AiPlanView>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/repropose',
    {
      workspaceId: config.workspaceId,
      proposalId,
      ...(choiceId ? { choiceId } : {}),
      ...(choices && Object.keys(choices).length > 0 ? { choices } : {}),
    },
    fetchImpl,
  );

  return readPlanOutcome(payload);
};

export const proposeAiCapture = async (
  config: AiCommandBarConfig,
  source: AiCaptureSource,
  text: string,
  fetchImpl: FetchImpl,
  image?: AiCaptureImage,
): Promise<AiCommandOutcome<AiPlanView>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/plan',
    {
      workspaceId: config.workspaceId,
      capture: {
        source,
        ...(text.length > 0 ? { text } : {}),
        ...(image ? { image } : {}),
      },
    },
    fetchImpl,
  );

  return readPlanOutcome(payload);
};

export const proposeAiSkill = async (
  config: AiCommandBarConfig,
  skillId: string,
  fetchImpl: FetchImpl,
  parameterValues?: Record<string, string | number>,
): Promise<AiCommandOutcome<AiPlanView>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/plan',
    {
      workspaceId: config.workspaceId,
      skillId,
      ...(parameterValues ? { parameterValues } : {}),
    },
    fetchImpl,
  );

  return readPlanOutcome(payload);
};

export const saveAiSkill = async (
  config: AiCommandBarConfig,
  skillName: string,
  confirmedPlanId: string,
  fetchImpl: FetchImpl,
  blanks?: string[],
): Promise<AiCommandOutcome<AiSkill>> => {
  const payload = await postAiCommand(
    config,
    '/v1/ai/skills',
    {
      workspaceId: config.workspaceId,
      skillName,
      confirmedPlanId,
      ...(blanks && blanks.length > 0 ? { blanks } : {}),
    },
    fetchImpl,
  );

  if (payload.kind !== 'data') {
    return payload;
  }

  const skill = readSkill(payload.data);

  if (!skill) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected skill.',
    };
  }

  return { kind: 'data', data: skill };
};

export const listAiSkills = async (
  config: AiCommandBarConfig,
  fetchImpl: FetchImpl,
): Promise<AiCommandOutcome<AiSkill[]>> => {
  let response: Response;

  try {
    response = await fetchImpl(
      `${config.gatewayUrl}/v1/ai/skills?workspaceId=${encodeURIComponent(config.workspaceId)}`,
      {
        method: 'GET',
        credentials: 'include',
      },
    );
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
    return { kind: 'message', message: readMessage(payload) };
  }

  if (!Array.isArray(payload.skills)) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected skill list.',
    };
  }

  const skills = payload.skills.flatMap((skill) => {
    const parsed = readSkill({ skill });

    return parsed ? [parsed] : [];
  });

  return { kind: 'data', data: skills };
};

const readPlanOutcome = (
  payload: AiCommandOutcome<unknown>,
): AiCommandOutcome<AiPlanView> => {
  if (payload.kind !== 'data') {
    return payload;
  }

  const view = readPlan(payload.data);

  if (!view) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an unexpected plan.',
    };
  }

  return { kind: 'data', data: view };
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

  if (payload.kind !== 'data') {
    return payload.kind === 'message'
      ? payload
      : { kind: 'message', message: payload.message };
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
  onProgress?: (message: string) => void,
  onRead?: (records: AiAnswerRecord[]) => void,
): Promise<AiCommandOutcome<unknown>> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (onPartial || onProgress || onRead) {
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
    return onProgress
      ? readActStream(response, onProgress)
      : readPlanStream(response, onPartial, onRead);
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

  const stale = readStale(payload);

  if (stale) {
    return { kind: 'stale', message: readMessage(payload), changes: stale };
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
  onRead?: (records: AiAnswerRecord[]) => void,
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

      if (event.name === 'read') {
        const records = readReadRecords(event.data);

        if (records && onRead) {
          onRead(records);
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

const readActStream = async (
  response: Response,
  onProgress: (message: string) => void,
): Promise<AiCommandOutcome<unknown>> => {
  const body = response.body;

  if (!body) {
    return {
      kind: 'message',
      message: 'The AI gateway returned an empty result.',
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: unknown;
  let failure: string | undefined;
  let stale: AiProposalChange[] | undefined;

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

      if (event.name === 'progress') {
        const line = readProgress(event.data);

        if (line) {
          onProgress(line);
        }

        continue;
      }

      if (event.name === 'result') {
        result = event.data;
        continue;
      }

      if (event.name === 'error') {
        stale = readStale(event.data);
        failure = readMessage(event.data);
      }
    }
  }

  if (stale) {
    return {
      kind: 'stale',
      message: failure ?? 'Confirm is blocked.',
      changes: stale,
    };
  }

  if (result !== undefined && isPlainObject(result) && result.ok === true) {
    return { kind: 'data', data: result };
  }

  return {
    kind: 'message',
    message:
      failure ??
      readMessage(result) ??
      'The update stopped before every record settled.',
  };
};

const readProgress = (payload: unknown): string | undefined => {
  if (
    !isPlainObject(payload) ||
    typeof payload.index !== 'number' ||
    typeof payload.total !== 'number' ||
    typeof payload.label !== 'string'
  ) {
    return undefined;
  }

  return `Updated ${payload.label} (${payload.index} of ${payload.total}).`;
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

const readPlan = (payload: unknown): AiPlanView | undefined => {
  if (!isPlainObject(payload)) {
    return undefined;
  }

  const proposal =
    payload.proposal === undefined ? undefined : readProposal(payload);
  const answer =
    payload.answer === undefined ? undefined : readAnswer(payload.answer);
  const parameters =
    payload.parameters === undefined
      ? undefined
      : readParameters(payload.parameters);

  if (payload.proposal !== undefined && !proposal) {
    return undefined;
  }

  if (payload.answer !== undefined && !answer) {
    return undefined;
  }

  if (payload.parameters !== undefined && !parameters) {
    return undefined;
  }

  if (!proposal && !answer && !parameters) {
    return undefined;
  }

  return {
    ...(proposal ? { proposal } : {}),
    ...(answer ? { answer } : {}),
    ...(parameters ? { parameters } : {}),
  };
};

const readParameters = (value: unknown): AiSkillParameter[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parameters: AiSkillParameter[] = [];

  for (const item of value) {
    if (
      !isPlainObject(item) ||
      typeof item.name !== 'string' ||
      typeof item.label !== 'string'
    ) {
      return undefined;
    }

    parameters.push({ name: item.name, label: item.label });
  }

  return parameters;
};

const readReadRecords = (payload: unknown): AiAnswerRecord[] | undefined => {
  if (!isPlainObject(payload) || !Array.isArray(payload.records)) {
    return undefined;
  }

  const answer = readAnswer({
    summary: 'Reading…',
    records: payload.records,
  });

  return answer?.records;
};

const readAnswer = (value: unknown): AiAnswer | undefined => {
  if (
    !isPlainObject(value) ||
    typeof value.summary !== 'string' ||
    !Array.isArray(value.records)
  ) {
    return undefined;
  }

  const records: AiAnswerRecord[] = [];

  for (const record of value.records) {
    if (
      !isPlainObject(record) ||
      typeof record.id !== 'string' ||
      typeof record.objectName !== 'string' ||
      typeof record.label !== 'string'
    ) {
      return undefined;
    }

    records.push({
      id: record.id,
      objectName: record.objectName,
      label: record.label,
      ...(typeof record.detail === 'string' && record.detail.length > 0
        ? { detail: record.detail }
        : {}),
    });
  }

  return { summary: value.summary, records };
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

  const changes = readChanges(payload.proposal.changes);
  const warnings = readWarnings(payload.proposal.warnings);
  const creates = readCreates(payload.proposal.creates);

  if (payload.proposal.changes !== undefined && !changes) {
    return undefined;
  }

  if (payload.proposal.warnings !== undefined && !warnings) {
    return undefined;
  }

  if (payload.proposal.creates !== undefined && !creates) {
    return undefined;
  }

  return {
    id,
    summary,
    tools,
    lines: parsedLines,
    ...(choice ? { choice } : {}),
    ...(changes && changes.length > 0 ? { changes } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
    ...(creates && creates.length > 0 ? { creates } : {}),
  };
};

const readCreates = (value: unknown): AiProposalCreate[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const creates: AiProposalCreate[] = [];

  for (const create of value) {
    if (
      !isPlainObject(create) ||
      (create.objectName !== 'person' && create.objectName !== 'company') ||
      typeof create.label !== 'string' ||
      typeof create.summary !== 'string'
    ) {
      return undefined;
    }

    creates.push({
      objectName: create.objectName,
      label: create.label,
      summary: create.summary,
    });
  }

  return creates;
};

const readChanges = (value: unknown): AiProposalChange[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const changes: AiProposalChange[] = [];

  for (const change of value) {
    if (
      !isPlainObject(change) ||
      typeof change.recordId !== 'string' ||
      typeof change.objectName !== 'string' ||
      typeof change.label !== 'string' ||
      typeof change.summary !== 'string' ||
      !isDisplayValue(change.current) ||
      !isDisplayValue(change.proposed)
    ) {
      return undefined;
    }

    changes.push({
      recordId: change.recordId,
      objectName: change.objectName,
      label: change.label,
      summary: change.summary,
      current: change.current,
      proposed: change.proposed,
      ...(typeof change.field === 'string' ? { field: change.field } : {}),
      ...(typeof change.metadataField === 'string'
        ? { metadataField: change.metadataField }
        : {}),
    });
  }

  return changes;
};

const isDisplayValue = (value: unknown): value is string | number | null =>
  value === null || typeof value === 'string' || typeof value === 'number';

const readWarnings = (value: unknown): AiProposalWarning[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const warnings: AiProposalWarning[] = [];

  for (const warning of value) {
    if (
      !isPlainObject(warning) ||
      typeof warning.code !== 'string' ||
      typeof warning.message !== 'string'
    ) {
      return undefined;
    }

    warnings.push({ code: warning.code, message: warning.message });
  }

  return warnings;
};

const readStale = (payload: unknown): AiProposalChange[] | undefined => {
  if (!isPlainObject(payload) || payload.stale === undefined) {
    return undefined;
  }

  return readChanges(payload.stale);
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

const readConfirmedPlanId = (payload: unknown): string | undefined => {
  if (!isPlainObject(payload) || typeof payload.confirmedPlanId !== 'string') {
    return undefined;
  }

  return payload.confirmedPlanId;
};

const readSkill = (payload: unknown): AiSkill | undefined => {
  if (!isPlainObject(payload) || !isPlainObject(payload.skill)) {
    return undefined;
  }

  const { id, name, tools } = payload.skill;

  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    !Array.isArray(tools)
  ) {
    return undefined;
  }

  const toolNames = tools.filter(
    (tool): tool is string => typeof tool === 'string',
  );
  const parameters = Array.isArray(payload.skill.parameters)
    ? payload.skill.parameters.filter(
        (parameter): parameter is string => typeof parameter === 'string',
      )
    : undefined;

  return {
    id,
    name,
    tools: toolNames,
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
  };
};

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
