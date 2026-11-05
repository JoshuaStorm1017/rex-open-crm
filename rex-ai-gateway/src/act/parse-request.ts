import { isRecord } from '../is-record';
import { WORKSPACE_ID_PATTERN } from './find-foreign-workspace-id';
import {
  MAX_TOOLS_PER_REQUEST,
  refusal,
  type ActRefusal,
  type ToolCall,
} from './types';

const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f-]{36}$/;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const UNDO_ID_PATTERN = /^undo_[0-9a-f-]{36}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type OpenRecordContext = {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
};

export type ParsedRequest = {
  workspaceId: string;
  tools?: ToolCall[];
  intent?: string;
  confirmed: boolean;
  proposalId?: string;
  choiceId?: string;
  choices?: Record<string, string>;
  undoId?: string;
  openRecord?: OpenRecordContext;
};

const MAX_INTENT_CHARS = 500;

export function parseGatewayRequest(body: unknown): ParsedRequest | ActRefusal {
  if (!isRecord(body)) {
    return refusal('invalid_request', 'Body must be a JSON object.');
  }

  if (typeof body.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(body.workspaceId)) {
    return refusal(
      'invalid_request',
      'workspaceId must be a gateway token such as "ws_demo".',
    );
  }

  let tools: ToolCall[] | undefined;

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return refusal('invalid_request', 'tools must be an array.');
    }

    if (body.tools.length > MAX_TOOLS_PER_REQUEST) {
      return refusal(
        'invalid_request',
        `A request can include at most ${MAX_TOOLS_PER_REQUEST} tools.`,
      );
    }

    tools = [];

    for (let index = 0; index < body.tools.length; index += 1) {
      const parsedTool = parseToolCall(body.tools[index], index);

      if ('refused' in parsedTool) {
        return parsedTool;
      }

      tools.push(parsedTool);
    }
  }

  if (body.intent !== undefined && typeof body.intent !== 'string') {
    return refusal('invalid_request', 'intent must be a string.');
  }

  if (typeof body.intent === 'string' && body.intent.trim().length > MAX_INTENT_CHARS) {
    return refusal(
      'invalid_request',
      `intent must be at most ${MAX_INTENT_CHARS} characters.`,
    );
  }

  if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
    return refusal('invalid_request', 'confirmed must be a boolean.');
  }

  if (body.proposalId !== undefined && typeof body.proposalId !== 'string') {
    return refusal('invalid_request', 'proposalId must be a string.');
  }

  if (typeof body.proposalId === 'string' && !PROPOSAL_ID_PATTERN.test(body.proposalId)) {
    return refusal(
      'invalid_request',
      'proposalId is not a preview id from POST /v1/ai/plan.',
    );
  }

  if (body.choiceId !== undefined && typeof body.choiceId !== 'string') {
    return refusal('invalid_request', 'choiceId must be a string.');
  }

  if (typeof body.choiceId === 'string' && !CHOICE_ID_PATTERN.test(body.choiceId)) {
    return refusal('invalid_request', 'choiceId is not one of the preview choices.');
  }

  const choices = parseChoices(body.choices);

  if ('refused' in choices) {
    return choices;
  }

  if (body.undoId !== undefined && typeof body.undoId !== 'string') {
    return refusal('invalid_request', 'undoId must be a string.');
  }

  if (typeof body.undoId === 'string' && !UNDO_ID_PATTERN.test(body.undoId)) {
    return refusal('invalid_request', 'undoId is not an undo id from a confirmed act.');
  }

  const openRecord = parseOpenRecord(body.context);

  if (openRecord && 'refused' in openRecord) {
    return openRecord;
  }

  return {
    workspaceId: body.workspaceId,
    ...(tools ? { tools } : {}),
    ...(typeof body.intent === 'string' ? { intent: body.intent } : {}),
    confirmed: body.confirmed === true,
    ...(typeof body.proposalId === 'string' ? { proposalId: body.proposalId } : {}),
    ...(typeof body.choiceId === 'string' ? { choiceId: body.choiceId } : {}),
    ...(choices.choices ? { choices: choices.choices } : {}),
    ...(typeof body.undoId === 'string' ? { undoId: body.undoId } : {}),
    ...(openRecord ? { openRecord } : {}),
  };
}

function parseChoices(value: unknown): { choices?: Record<string, string> } | ActRefusal {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'choices must be an object.');
  }

  const keys = Object.keys(value);

  if (keys.length > MAX_TOOLS_PER_REQUEST) {
    return refusal('invalid_request', 'choices has too many names.');
  }

  const choices: Record<string, string> = {};

  for (const key of keys) {
    if (!/^[0-9]{1,2}$/.test(key)) {
      return refusal('invalid_request', 'choices keys must be preview group ids.');
    }

    const choiceId = value[key];

    if (typeof choiceId !== 'string' || !CHOICE_ID_PATTERN.test(choiceId)) {
      return refusal('invalid_request', 'choices values must be preview choice ids.');
    }

    choices[key] = choiceId;
  }

  return { choices };
}

function parseOpenRecord(value: unknown): OpenRecordContext | undefined | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'context must be an object.');
  }

  const { objectName, recordId } = value;

  if (objectName !== 'person' && objectName !== 'company' && objectName !== 'opportunity') {
    return refusal(
      'invalid_request',
      'context.objectName must be person, company, or opportunity.',
    );
  }

  if (typeof recordId !== 'string' || !RECORD_ID_PATTERN.test(recordId)) {
    return refusal('invalid_request', 'context.recordId is not a record id.');
  }

  return { objectName, recordId };
}

function parseToolCall(value: unknown, index: number): ToolCall | ActRefusal {
  if (!isRecord(value)) {
    return refusal('invalid_request', `tools[${index}] must be an object.`);
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return refusal('invalid_request', `tools[${index}].name must be a string.`);
  }

  if (!isRecord(value.args)) {
    return refusal('invalid_request', `tools[${index}].args must be an object.`, {
      toolName: value.name,
    });
  }

  return { name: value.name.trim(), args: value.args };
}
