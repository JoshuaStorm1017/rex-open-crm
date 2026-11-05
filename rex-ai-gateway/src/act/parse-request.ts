import { isRecord } from '../is-record';
import { WORKSPACE_ID_PATTERN } from './find-foreign-workspace-id';
import {
  isSkillParameterName,
  parseSkillParameterValue,
  SKILL_PARAMETER_NAMES,
  type SkillParameterName,
} from './skill-parameters';
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
const SKILL_ID_PATTERN = /^skill_[0-9a-f-]{36}$/;
const CONFIRMED_PLAN_ID_PATTERN = /^confirmed_[0-9a-f-]{36}$/;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,39}$/;
const MAX_CAPTURE_CHARS = 8000;
const MAX_IMAGE_CHARS = 1_000_000;
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type OpenRecordContext = {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
};

export type CaptureImage = {
  mediaType: (typeof IMAGE_MEDIA_TYPES)[number];
  data: string;
};

export type CaptureRequest = {
  source: 'card' | 'voice';
  text?: string;
  image?: CaptureImage;
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
  capture?: CaptureRequest;
  skillId?: string;
  skillName?: string;
  confirmedPlanId?: string;
  blanks?: SkillParameterName[];
  parameterValues?: Partial<Record<SkillParameterName, string | number>>;
  linkCompanyId?: string;
};

const MAX_INTENT_CHARS = 500;

export function parseGatewayRequest(body: unknown): ParsedRequest | ActRefusal {
  if (!isRecord(body)) {
    return refusal('invalid_request', 'Body must be a JSON object.');
  }

  if (
    typeof body.workspaceId !== 'string' ||
    !WORKSPACE_ID_PATTERN.test(body.workspaceId)
  ) {
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

  if (
    typeof body.intent === 'string' &&
    body.intent.trim().length > MAX_INTENT_CHARS
  ) {
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

  if (
    typeof body.proposalId === 'string' &&
    !PROPOSAL_ID_PATTERN.test(body.proposalId)
  ) {
    return refusal(
      'invalid_request',
      'proposalId is not a preview id from POST /v1/ai/plan.',
    );
  }

  if (body.choiceId !== undefined && typeof body.choiceId !== 'string') {
    return refusal('invalid_request', 'choiceId must be a string.');
  }

  if (
    typeof body.choiceId === 'string' &&
    !CHOICE_ID_PATTERN.test(body.choiceId)
  ) {
    return refusal(
      'invalid_request',
      'choiceId is not one of the preview choices.',
    );
  }

  const choices = parseChoices(body.choices);

  if ('refused' in choices) {
    return choices;
  }

  if (body.undoId !== undefined && typeof body.undoId !== 'string') {
    return refusal('invalid_request', 'undoId must be a string.');
  }

  if (typeof body.undoId === 'string' && !UNDO_ID_PATTERN.test(body.undoId)) {
    return refusal(
      'invalid_request',
      'undoId is not an undo id from a confirmed act.',
    );
  }

  const openRecord = parseOpenRecord(body.context);

  if (openRecord && 'refused' in openRecord) {
    return openRecord;
  }

  const capture = parseCapture(body.capture);

  if (capture && 'refused' in capture) {
    return capture;
  }

  if (body.skillId !== undefined && typeof body.skillId !== 'string') {
    return refusal('invalid_request', 'skillId must be a string.');
  }

  if (
    typeof body.skillId === 'string' &&
    !SKILL_ID_PATTERN.test(body.skillId)
  ) {
    return refusal('invalid_request', 'skillId is not a saved skill id.');
  }

  if (body.skillName !== undefined && typeof body.skillName !== 'string') {
    return refusal('invalid_request', 'skillName must be a string.');
  }

  if (
    typeof body.skillName === 'string' &&
    !SKILL_NAME_PATTERN.test(body.skillName)
  ) {
    return refusal(
      'invalid_request',
      "skillName must be 1–40 letters, numbers, spaces, or . ' -.",
    );
  }

  if (
    body.confirmedPlanId !== undefined &&
    typeof body.confirmedPlanId !== 'string'
  ) {
    return refusal('invalid_request', 'confirmedPlanId must be a string.');
  }

  if (
    typeof body.confirmedPlanId === 'string' &&
    !CONFIRMED_PLAN_ID_PATTERN.test(body.confirmedPlanId)
  ) {
    return refusal(
      'invalid_request',
      'confirmedPlanId is not an id from a confirmed act.',
    );
  }

  const blanks = parseBlanks(body.blanks);

  if (blanks && 'refused' in blanks) {
    return blanks;
  }

  const parameterValues = parseParameterValues(body.parameterValues);

  if (parameterValues && 'refused' in parameterValues) {
    return parameterValues;
  }

  if (
    body.linkCompanyId !== undefined &&
    (typeof body.linkCompanyId !== 'string' ||
      !RECORD_ID_PATTERN.test(body.linkCompanyId))
  ) {
    return refusal('invalid_request', 'linkCompanyId is not a company id.');
  }

  return {
    workspaceId: body.workspaceId,
    ...(tools ? { tools } : {}),
    ...(typeof body.intent === 'string' ? { intent: body.intent } : {}),
    confirmed: body.confirmed === true,
    ...(typeof body.proposalId === 'string'
      ? { proposalId: body.proposalId }
      : {}),
    ...(typeof body.choiceId === 'string' ? { choiceId: body.choiceId } : {}),
    ...(choices.choices ? { choices: choices.choices } : {}),
    ...(typeof body.undoId === 'string' ? { undoId: body.undoId } : {}),
    ...(openRecord ? { openRecord } : {}),
    ...(capture ? { capture } : {}),
    ...(typeof body.skillId === 'string' ? { skillId: body.skillId } : {}),
    ...(typeof body.skillName === 'string'
      ? { skillName: body.skillName }
      : {}),
    ...(typeof body.confirmedPlanId === 'string'
      ? { confirmedPlanId: body.confirmedPlanId }
      : {}),
    ...(blanks && blanks.length > 0 ? { blanks } : {}),
    ...(parameterValues ? { parameterValues } : {}),
    ...(typeof body.linkCompanyId === 'string'
      ? { linkCompanyId: body.linkCompanyId }
      : {}),
  };
}

function parseCapture(value: unknown): CaptureRequest | undefined | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'capture must be an object.');
  }

  if (value.source !== 'card' && value.source !== 'voice') {
    return refusal('invalid_request', 'capture.source must be card or voice.');
  }

  const image = parseCaptureImage(value.image);

  if (image && 'refused' in image) {
    return image;
  }

  if (image && value.source !== 'card') {
    return refusal('invalid_request', 'A photo is only read from a card.');
  }

  let text: string | undefined;

  if (value.text !== undefined) {
    if (typeof value.text !== 'string') {
      return refusal('invalid_request', 'capture.text must be a string.');
    }

    text = value.text.trim();

    if (text.length === 0 || text.length > MAX_CAPTURE_CHARS) {
      return refusal(
        'invalid_request',
        `capture.text must be 1–${MAX_CAPTURE_CHARS} characters.`,
      );
    }
  }

  if (!text && !image) {
    return refusal(
      'invalid_request',
      'capture needs card text, a vCard, or a photo.',
    );
  }

  return {
    source: value.source,
    ...(text ? { text } : {}),
    ...(image ? { image } : {}),
  };
}

function parseCaptureImage(
  value: unknown,
): CaptureImage | undefined | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'capture.image must be an object.');
  }

  if (
    typeof value.mediaType !== 'string' ||
    !IMAGE_MEDIA_TYPES.includes(
      value.mediaType as (typeof IMAGE_MEDIA_TYPES)[number],
    )
  ) {
    return refusal(
      'invalid_request',
      'capture.image.mediaType must be image/jpeg, image/png, or image/webp.',
    );
  }

  if (
    typeof value.data !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  ) {
    return refusal('invalid_request', 'capture.image.data must be base64.');
  }

  if (value.data.length > MAX_IMAGE_CHARS) {
    return refusal(
      'invalid_request',
      'That photo is too large. Paste the card text or a vCard.',
    );
  }

  return {
    mediaType: value.mediaType as CaptureImage['mediaType'],
    data: value.data,
  };
}

function parseBlanks(
  value: unknown,
): SkillParameterName[] | undefined | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length > SKILL_PARAMETER_NAMES.length) {
    return refusal(
      'invalid_request',
      'blanks must list city, amount, stage, company, owner, or closeDate.',
    );
  }

  const blanks: SkillParameterName[] = [];

  for (const item of value) {
    if (typeof item !== 'string' || !isSkillParameterName(item)) {
      return refusal(
        'invalid_request',
        'blanks must list city, amount, stage, company, owner, or closeDate.',
      );
    }

    if (!blanks.includes(item)) {
      blanks.push(item);
    }
  }

  return blanks;
}

function parseParameterValues(
  value: unknown,
):
  | Partial<Record<SkillParameterName, string | number>>
  | undefined
  | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'parameterValues must be an object.');
  }

  const values: Partial<Record<SkillParameterName, string | number>> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!isSkillParameterName(key)) {
      return refusal(
        'invalid_request',
        'parameterValues only accepts city, amount, stage, company, owner, or closeDate.',
      );
    }

    const parsed = parseSkillParameterValue(key, raw);

    if (!parsed.ok) {
      return refusal('invalid_request', parsed.message);
    }

    values[key] = parsed.value;
  }

  return values;
}

function parseChoices(
  value: unknown,
): { choices?: Record<string, string> } | ActRefusal {
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
      return refusal(
        'invalid_request',
        'choices keys must be preview group ids.',
      );
    }

    const choiceId = value[key];

    if (typeof choiceId !== 'string' || !CHOICE_ID_PATTERN.test(choiceId)) {
      return refusal(
        'invalid_request',
        'choices values must be preview choice ids.',
      );
    }

    choices[key] = choiceId;
  }

  return { choices };
}

function parseOpenRecord(
  value: unknown,
): OpenRecordContext | undefined | ActRefusal {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return refusal('invalid_request', 'context must be an object.');
  }

  const { objectName, recordId } = value;

  if (
    objectName !== 'person' &&
    objectName !== 'company' &&
    objectName !== 'opportunity'
  ) {
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
    return refusal(
      'invalid_request',
      `tools[${index}].args must be an object.`,
      {
        toolName: value.name,
      },
    );
  }

  return { name: value.name.trim(), args: value.args };
}
