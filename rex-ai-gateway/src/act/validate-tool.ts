import type {
  CreateCompanyInput,
  CreateOpportunityInput,
  CreatePersonInput,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import { isAllowedToolName } from './allowlist';
import { findForeignWorkspaceId } from './find-foreign-workspace-id';
import {
  ALLOWED_TOOL_NAMES,
  refusal,
  type ActRefusal,
  type AllowedToolName,
  type ToolCall,
} from './types';
import {
  isUpdatableField,
  isUpdatableObjectName,
  UPDATABLE_FIELDS,
  type UpdatableObjectName,
} from './writable-fields';

export type SearchRecordsToolInput = {
  objectName: TwentyObjectName;
  query: string;
  limit: number;
};

export type UpdateRecordToolInput = {
  objectName: UpdatableObjectName;
  id: string;
  field: string;
  value: string | number;
  ifMatch?: string;
};

export type ValidatedTool =
  | { name: 'create_person'; input: Omit<CreatePersonInput, 'workspaceId'> }
  | { name: 'create_company'; input: Omit<CreateCompanyInput, 'workspaceId'> }
  | {
      name: 'create_opportunity';
      input: Omit<CreateOpportunityInput, 'workspaceId'>;
    }
  | { name: 'search_records'; input: SearchRecordsToolInput }
  | { name: 'update_record'; input: UpdateRecordToolInput };

const DEFAULT_OPPORTUNITY_STAGE = 'NEW';

export function validateTool(
  tool: ToolCall,
  requestWorkspaceId: string,
): ValidatedTool | ActRefusal {
  if (!isAllowedToolName(tool.name)) {
    return refusal(
      'unknown_tool',
      `Unknown tool "${tool.name}". Allowed tools: ${ALLOWED_TOOL_NAMES.join(', ')}.`,
      { toolName: tool.name },
    );
  }

  const foreignWorkspaceId = findForeignWorkspaceId(
    tool.args,
    requestWorkspaceId,
  );

  if (foreignWorkspaceId) {
    return refusal(
      'cross_workspace',
      `Refusing ${tool.name}: args reference workspace "${foreignWorkspaceId}", which is not the request workspace "${requestWorkspaceId}".`,
      { toolName: tool.name },
    );
  }

  switch (tool.name) {
    case 'create_person':
      return validatePerson(tool.args);
    case 'create_company':
      return validateCompany(tool.args);
    case 'create_opportunity':
      return validateOpportunity(tool.args);
    case 'search_records':
      return validateSearch(tool.args);
    case 'update_record':
      return validateUpdate(tool.args);
  }
}

function validatePerson(
  args: Record<string, unknown>,
): ValidatedTool | ActRefusal {
  const firstName = requireString(args, 'create_person', 'firstName');
  if (typeof firstName !== 'string') {
    return firstName;
  }

  const lastName = requireString(args, 'create_person', 'lastName');
  if (typeof lastName !== 'string') {
    return lastName;
  }

  const email = optionalString(args, 'create_person', 'email');
  if (isRefusal(email)) {
    return email;
  }

  const jobTitle = optionalString(args, 'create_person', 'jobTitle');
  if (isRefusal(jobTitle)) {
    return jobTitle;
  }

  const companyId = optionalRelationId(args, 'create_person', 'companyId');
  if (isRefusal(companyId)) {
    return companyId;
  }

  return {
    name: 'create_person',
    input: {
      firstName,
      lastName,
      ...(email ? { email } : {}),
      ...(jobTitle ? { jobTitle } : {}),
      ...(companyId ? { companyId } : {}),
    },
  };
}

function validateCompany(
  args: Record<string, unknown>,
): ValidatedTool | ActRefusal {
  const name = requireString(args, 'create_company', 'name');
  if (typeof name !== 'string') {
    return name;
  }

  const domain = optionalString(args, 'create_company', 'domain');
  if (isRefusal(domain)) {
    return domain;
  }

  return {
    name: 'create_company',
    input: {
      name,
      ...(domain ? { domain } : {}),
    },
  };
}

function validateOpportunity(
  args: Record<string, unknown>,
): ValidatedTool | ActRefusal {
  const name = requireString(args, 'create_opportunity', 'name');
  if (typeof name !== 'string') {
    return name;
  }

  const stage = optionalString(args, 'create_opportunity', 'stage');
  if (isRefusal(stage)) {
    return stage;
  }

  const currencyCode = optionalString(args, 'create_opportunity', 'currencyCode');
  if (isRefusal(currencyCode)) {
    return currencyCode;
  }

  const companyId = optionalRelationId(args, 'create_opportunity', 'companyId');
  if (isRefusal(companyId)) {
    return companyId;
  }

  const pointOfContactId = optionalRelationId(
    args,
    'create_opportunity',
    'pointOfContactId',
  );
  if (isRefusal(pointOfContactId)) {
    return pointOfContactId;
  }

  const closeDate = optionalString(args, 'create_opportunity', 'closeDate');
  if (isRefusal(closeDate)) {
    return closeDate;
  }

  const amount = optionalAmount(args);
  if (isRefusal(amount)) {
    return amount;
  }

  if (currencyCode && amount === undefined) {
    return refusal(
      'invalid_request',
      'create_opportunity currencyCode requires amount.',
      { toolName: 'create_opportunity' },
    );
  }

  return {
    name: 'create_opportunity',
    input: {
      name,
      stage: stage ?? DEFAULT_OPPORTUNITY_STAGE,
      ...(amount !== undefined ? { amount } : {}),
      ...(currencyCode ? { currencyCode } : {}),
      ...(companyId ? { companyId } : {}),
      ...(pointOfContactId ? { pointOfContactId } : {}),
      ...(closeDate ? { closeDate } : {}),
    },
  };
}

const RELATION_ID_PATTERN = /^(\$[0-9]+|[A-Za-z0-9_-]{1,80})$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const IF_MATCH_PATTERN = /^[A-Za-z0-9_.:T+Z-]{1,80}$/;
const STAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const SEARCH_QUERY_PATTERN = /["()[\]\\%,;*{}|&<>$`_\u0000-\u001f]/;

function validateSearch(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const objectName = requireObjectName(args, 'search_records');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const query = requireString(args, 'search_records', 'query');

  if (typeof query !== 'string') {
    return query;
  }

  if (query.length > 80 || SEARCH_QUERY_PATTERN.test(query)) {
    return refusal(
      'invalid_request',
      'search_records query must be 1–80 characters and cannot contain filter punctuation.',
      { toolName: 'search_records' },
    );
  }

  const limit = optionalLimit(args);

  if (isRefusal(limit)) {
    return limit;
  }

  return {
    name: 'search_records',
    input: {
      objectName,
      query,
      limit: limit ?? 10,
    },
  };
}

function validateUpdate(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const objectName = requireObjectName(args, 'update_record');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const id = requireString(args, 'update_record', 'id');

  if (typeof id !== 'string') {
    return id;
  }

  if (!RECORD_ID_PATTERN.test(id)) {
    return invalidField('update_record', 'id');
  }

  const field = requireString(args, 'update_record', 'field');

  if (typeof field !== 'string') {
    return field;
  }

  if (!isUpdatableField(objectName, field)) {
    return refusal(
      'invalid_request',
      `update_record cannot write ${objectName}.${field}. Writable fields: ${UPDATABLE_FIELDS[objectName].join(', ')}.`,
      { toolName: 'update_record' },
    );
  }

  const ifMatch = optionalString(args, 'update_record', 'ifMatch');

  if (isRefusal(ifMatch)) {
    return ifMatch;
  }

  if (ifMatch && !IF_MATCH_PATTERN.test(ifMatch)) {
    return invalidField('update_record', 'ifMatch');
  }

  const value = readUpdateValue(args, objectName, field);

  if (isRefusal(value)) {
    return value;
  }

  return {
    name: 'update_record',
    input: {
      objectName,
      id,
      field,
      value,
      ...(ifMatch ? { ifMatch } : {}),
    },
  };
}

function requireObjectName(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
): UpdatableObjectName | ActRefusal {
  const objectName = requireString(args, toolName, 'object');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  if (!isUpdatableObjectName(objectName)) {
    return refusal(
      'invalid_request',
      `${toolName} object must be person, company, or opportunity.`,
      { toolName },
    );
  }

  return objectName;
}

function optionalRelationId(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
  key: string,
): string | undefined | ActRefusal {
  const read = optionalString(args, toolName, key);

  if (isRefusal(read) || read === undefined) {
    return read;
  }

  if (!RELATION_ID_PATTERN.test(read)) {
    return invalidField(toolName, key);
  }

  return read;
}

function optionalLimit(args: Record<string, unknown>): number | undefined | ActRefusal {
  if (!Object.prototype.hasOwnProperty.call(args, 'limit') || args.limit == null) {
    return undefined;
  }

  const limit = args.limit;

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    return refusal(
      'invalid_request',
      'search_records limit must be an integer from 1 to 20.',
      { toolName: 'search_records' },
    );
  }

  return limit;
}

function readUpdateValue(
  args: Record<string, unknown>,
  objectName: UpdatableObjectName,
  field: string,
): string | number | ActRefusal {
  if (!Object.prototype.hasOwnProperty.call(args, 'value') || args.value == null) {
    return refusal(
      'missing_required_fields',
      'Refusing update_record: missing required fields: value.',
      { toolName: 'update_record', missingFields: ['value'] },
    );
  }

  if (field === 'amount') {
    const amount = readNonNegativeAmount(args.value);

    if (amount === undefined) {
      return refusal(
        'invalid_request',
        'Refusing update_record: amount must be a finite number greater than or equal to 0.',
        { toolName: 'update_record' },
      );
    }

    return amount;
  }

  if (typeof args.value !== 'string' || args.value.trim().length === 0) {
    return invalidField('update_record', 'value');
  }

  const value = args.value.trim();

  if (value.length > 200) {
    return refusal(
      'invalid_request',
      'update_record value must be at most 200 characters.',
      { toolName: 'update_record' },
    );
  }

  if (objectName === 'opportunity' && field === 'stage' && !STAGE_PATTERN.test(value)) {
    return refusal(
      'invalid_request',
      'update_record stage must be letters, numbers, or underscores.',
      { toolName: 'update_record' },
    );
  }

  return value;
}

function requireString(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
  key: string,
): string | ActRefusal {
  const read = readString(args, key);

  if (read === 'invalid') {
    return invalidField(toolName, key);
  }

  if (!read) {
    return refusal(
      'missing_required_fields',
      `Refusing ${toolName}: missing required fields: ${key}.`,
      { toolName, missingFields: [key] },
    );
  }

  return read;
}

function optionalString(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
  key: string,
): string | undefined | ActRefusal {
  const read = readString(args, key);

  if (read === 'invalid') {
    return invalidField(toolName, key);
  }

  return read;
}

function optionalAmount(
  args: Record<string, unknown>,
): number | undefined | ActRefusal {
  if (!Object.prototype.hasOwnProperty.call(args, 'amount') || args.amount == null) {
    return undefined;
  }

  const amount = readNonNegativeAmount(args.amount);

  if (amount === undefined) {
    return refusal(
      'invalid_request',
      'Refusing create_opportunity: amount must be a finite number greater than or equal to 0.',
      { toolName: 'create_opportunity' },
    );
  }

  return amount;
}

const MAX_MAJOR_AMOUNT = 1_000_000_000;

// A present amount that is not a finite number >= 0 is refused. Never substitute 0.
// Micros must stay inside Number.MAX_SAFE_INTEGER or the currency write is not the amount the user confirmed.
function readNonNegativeAmount(value: unknown): number | undefined {
  let numeric: number | undefined;

  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    numeric = Number(value.trim());
  }

  if (numeric === undefined || !Number.isFinite(numeric) || numeric < 0 || numeric > MAX_MAJOR_AMOUNT) {
    return undefined;
  }

  const micros = Math.round(numeric * 1_000_000);

  return Number.isSafeInteger(micros) ? numeric : undefined;
}

function readString(
  args: Record<string, unknown>,
  key: string,
): string | undefined | 'invalid' {
  if (!Object.prototype.hasOwnProperty.call(args, key) || args[key] == null) {
    return undefined;
  }

  const value = args[key];

  if (typeof value !== 'string') {
    return 'invalid';
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

function invalidField(toolName: AllowedToolName, field: string): ActRefusal {
  return refusal(
    'invalid_request',
    `${toolName} field "${field}" has an invalid type.`,
    { toolName },
  );
}

function isRefusal(value: unknown): value is ActRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'refused' in value &&
    value.refused === true
  );
}
