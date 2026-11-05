import type {
  CreateCompanyInput,
  CreateNoteInput,
  CreateOpportunityInput,
  CreatePersonInput,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import { canonicalLinkedinUrl } from '../twenty/linkedin-url';
import { canonicalOpportunityStage } from '../twenty/opportunity-stages';
import { parsePhone } from '../twenty/parse-phone';
import { isSafeSearchQuery } from '../twenty/safe-search';
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

export type SearchTimelineToolInput = {
  query: string;
  limit: number;
};

export type UpdateRecordToolInput = {
  objectName: UpdatableObjectName;
  id?: string;
  query?: string;
  field: string;
  value: string | number;
  ifMatch?: string;
  useOpenRecord?: boolean;
};

export type ArchiveRecordToolInput = {
  objectName: UpdatableObjectName;
  id?: string;
  query?: string;
  ifMatch?: string;
  useOpenRecord?: boolean;
};

export type ValidatedTool =
  | { name: 'create_person'; input: Omit<CreatePersonInput, 'workspaceId'> }
  | { name: 'create_company'; input: Omit<CreateCompanyInput, 'workspaceId'> }
  | {
      name: 'create_opportunity';
      input: Omit<CreateOpportunityInput, 'workspaceId'>;
    }
  | {
      name: 'create_note';
      input: Omit<CreateNoteInput, 'workspaceId'> & { useOpenRecord?: boolean };
    }
  | { name: 'search_records'; input: SearchRecordsToolInput }
  | { name: 'search_notes'; input: SearchTimelineToolInput }
  | { name: 'search_tasks'; input: SearchTimelineToolInput }
  | { name: 'search_activities'; input: SearchTimelineToolInput }
  | { name: 'update_record'; input: UpdateRecordToolInput }
  | { name: 'update_matching_records'; input: UpdateRecordToolInput }
  | { name: 'archive_record'; input: ArchiveRecordToolInput };

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

  const unknownArg = rejectUnknownArgs(tool.name, tool.args);

  if (unknownArg) {
    return unknownArg;
  }

  switch (tool.name) {
    case 'create_person':
      return validatePerson(tool.args);
    case 'create_company':
      return validateCompany(tool.args);
    case 'create_opportunity':
      return validateOpportunity(tool.args);
    case 'create_note':
      return validateNote(tool.args);
    case 'search_records':
      return validateSearch(tool.args);
    case 'search_notes':
    case 'search_tasks':
    case 'search_activities':
      return validateTimelineSearch(tool.name, tool.args);
    case 'update_record':
      return validateUpdate(tool.args);
    case 'update_matching_records':
      return validateBulkUpdate(tool.args);
    case 'archive_record':
      return validateArchive(tool.args);
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

  const phone = optionalPhone(args, 'create_person');
  if (isRefusal(phone)) {
    return phone;
  }

  const linkedin = optionalLinkedin(args, 'create_person');
  if (isRefusal(linkedin)) {
    return linkedin;
  }

  return {
    name: 'create_person',
    input: {
      firstName,
      lastName,
      ...(email ? { email } : {}),
      ...(jobTitle ? { jobTitle } : {}),
      ...(phone ? { phone } : {}),
      ...(linkedin ? { linkedin } : {}),
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

  const website = optionalString(args, 'create_company', 'website');
  if (isRefusal(website)) {
    return website;
  }

  if (domain && website && domain !== website) {
    return refusal('invalid_request', 'create_company domain and website must be the same link.', {
      toolName: 'create_company',
    });
  }

  const linkedin = optionalLinkedin(args, 'create_company');
  if (isRefusal(linkedin)) {
    return linkedin;
  }

  const address = optionalPlainText(args, 'create_company', 'address');
  if (isRefusal(address)) {
    return address;
  }

  const city = optionalPlainText(args, 'create_company', 'city');
  if (isRefusal(city)) {
    return city;
  }

  const link = domain ?? website;

  return {
    name: 'create_company',
    input: {
      name,
      ...(link ? { domain: link } : {}),
      ...(linkedin ? { linkedin } : {}),
      ...(address ? { address } : {}),
      ...(city ? { city } : {}),
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

  const stage = optionalStage(args, 'create_opportunity');
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

  if (closeDate && !isCalendarDate(closeDate)) {
    return refusal(
      'invalid_request',
      'create_opportunity closeDate must be a calendar date, YYYY-MM-DD.',
      { toolName: 'create_opportunity' },
    );
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
const RECORD_ID_PATTERN = /^(\$[0-9]+|[A-Za-z0-9_-]{1,80})$/;
const IF_MATCH_PATTERN = /^[A-Za-z0-9_.:T+Z-]{1,80}$/;
const MEMBER_ID_PATTERN =
  /^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_SHORT_TEXT = 200;
const MAX_NOTE_BODY = 4000;

function validateSearch(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const objectName = requireObjectName(args, 'search_records');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const query = requireString(args, 'search_records', 'query');

  if (typeof query !== 'string') {
    return query;
  }

  if (!isSafeSearchQuery(query)) {
    return refusal(
      'invalid_request',
      'search_records query must be 1–80 letters, numbers, spaces, or . @ \' + -, with no filter syntax or LIKE wildcards.',
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

function validateTimelineSearch(
  toolName: 'search_notes' | 'search_tasks' | 'search_activities',
  args: Record<string, unknown>,
): ValidatedTool | ActRefusal {
  const query = requireString(args, toolName, 'query');

  if (typeof query !== 'string') {
    return query;
  }

  if (!isSafeSearchQuery(query)) {
    return refusal(
      'invalid_request',
      `${toolName} query must be 1–80 letters, numbers, spaces, or . @ ' + -, with no filter syntax or LIKE wildcards.`,
      { toolName },
    );
  }

  const limit = optionalLimit(args, toolName);

  if (isRefusal(limit)) {
    return limit;
  }

  return {
    name: toolName,
    input: {
      query,
      limit: limit ?? 10,
    },
  };
}

function validateBulkUpdate(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const update = validateUpdate({ ...args, id: 'bulk' });

  if (isRefusal(update)) {
    return refusal(update.reason, update.message.replaceAll('update_record', 'update_matching_records'), {
      toolName: 'update_matching_records',
      missingFields: update.missingFields,
    });
  }

  if (update.name !== 'update_record') {
    return update;
  }

  const query = optionalString(args, 'update_matching_records', 'query');

  if (isRefusal(query)) {
    return query;
  }

  if (!query) {
    return refusal(
      'missing_required_fields',
      'Refusing update_matching_records: missing required fields: query.',
      { toolName: 'update_matching_records', missingFields: ['query'] },
    );
  }

  if (!isSafeSearchQuery(query)) {
    return refusal(
      'invalid_request',
      'update_matching_records query must be 1–80 letters, numbers, spaces, or . @ \' + -, with no filter syntax or LIKE wildcards.',
      { toolName: 'update_matching_records' },
    );
  }

  return {
    name: 'update_matching_records',
    input: {
      objectName: update.input.objectName,
      query,
      field: update.input.field,
      value: update.input.value,
    },
  };
}

function validateUpdate(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const objectName = requireObjectName(args, 'update_record');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const id = optionalString(args, 'update_record', 'id');

  if (isRefusal(id)) {
    return id;
  }

  const query = optionalString(args, 'update_record', 'query');

  if (isRefusal(query)) {
    return query;
  }

  const useOpenRecord = readOpenRecordFlag(args, 'update_record');

  if (typeof useOpenRecord !== 'boolean') {
    return useOpenRecord;
  }

  if (!id && !query && !useOpenRecord) {
    return refusal(
      'missing_required_fields',
      'Refusing update_record: missing required fields: id.',
      { toolName: 'update_record', missingFields: ['id'] },
    );
  }

  if (id && !RECORD_ID_PATTERN.test(id)) {
    return invalidField('update_record', 'id');
  }

  if (id?.startsWith('$')) {
    // The etag of a record created earlier in this request is not known yet.
    const createdMatch = optionalString(args, 'update_record', 'ifMatch');

    if (isRefusal(createdMatch)) {
      return createdMatch;
    }

    if (createdMatch !== 'created') {
      return refusal(
        'invalid_request',
        'An update that points at $n must set ifMatch to "created". The etag is taken from that earlier create.',
        { toolName: 'update_record' },
      );
    }
  }

  if (query && !isSafeSearchQuery(query)) {
    return refusal(
      'invalid_request',
      'update_record query must be 1–80 letters, numbers, spaces, or . @ \' + -, with no filter syntax or LIKE wildcards.',
      { toolName: 'update_record' },
    );
  }

  const rawField = requireString(args, 'update_record', 'field');

  if (typeof rawField !== 'string') {
    return rawField;
  }

  const field = objectName === 'company' && rawField === 'owner' ? 'accountOwner' : rawField;

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
      ...(id && !useOpenRecord ? { id } : {}),
      ...(query && !id && !useOpenRecord ? { query } : {}),
      field,
      value,
      ...(ifMatch ? { ifMatch } : {}),
      ...(useOpenRecord ? { useOpenRecord: true } : {}),
    },
  };
}

function validateArchive(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const objectName = requireObjectName(args, 'archive_record');

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const id = optionalString(args, 'archive_record', 'id');

  if (isRefusal(id)) {
    return id;
  }

  const query = optionalString(args, 'archive_record', 'query');

  if (isRefusal(query)) {
    return query;
  }

  const useOpenRecord = readOpenRecordFlag(args, 'archive_record');

  if (typeof useOpenRecord !== 'boolean') {
    return useOpenRecord;
  }

  if (!id && !query && !useOpenRecord) {
    return refusal(
      'missing_required_fields',
      'Refusing archive_record: missing required fields: id.',
      { toolName: 'archive_record', missingFields: ['id'] },
    );
  }

  if (id && !RECORD_ID_PATTERN.test(id)) {
    return invalidField('archive_record', 'id');
  }

  if (query && !isSafeSearchQuery(query)) {
    return refusal(
      'invalid_request',
      'archive_record query must be 1–80 letters, numbers, spaces, or . @ \' + -, with no filter syntax or LIKE wildcards.',
      { toolName: 'archive_record' },
    );
  }

  const ifMatch = optionalString(args, 'archive_record', 'ifMatch');

  if (isRefusal(ifMatch)) {
    return ifMatch;
  }

  if (ifMatch && !IF_MATCH_PATTERN.test(ifMatch)) {
    return invalidField('archive_record', 'ifMatch');
  }

  return {
    name: 'archive_record',
    input: {
      objectName,
      ...(id && !useOpenRecord ? { id } : {}),
      ...(query && !id && !useOpenRecord ? { query } : {}),
      ...(ifMatch ? { ifMatch } : {}),
      ...(useOpenRecord ? { useOpenRecord: true } : {}),
    },
  };
}

function optionalStage(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
): string | undefined | ActRefusal {
  const stage = optionalString(args, toolName, 'stage');

  if (isRefusal(stage) || stage === undefined) {
    return stage;
  }

  const canonical = canonicalOpportunityStage(stage);

  if (!canonical) {
    return refusal(
      'invalid_request',
      'create_opportunity stage must be one of NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER.',
      { toolName },
    );
  }

  return canonical;
}

function optionalLinkedin(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
): string | undefined | ActRefusal {
  const linkedin = optionalString(args, toolName, 'linkedin');

  if (isRefusal(linkedin) || linkedin === undefined) {
    return linkedin;
  }

  const canonical = canonicalLinkedinUrl(linkedin);

  if (!canonical) {
    return refusal(
      'invalid_request',
      `${toolName} linkedin must be a linkedin.com profile URL, for example https://www.linkedin.com/in/ada.`,
      { toolName },
    );
  }

  return canonical;
}

function optionalPlainText(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
  key: string,
): string | undefined | ActRefusal {
  const value = optionalString(args, toolName, key);

  if (isRefusal(value) || value === undefined) {
    return value;
  }

  if (/[\u0000-\u001f]/.test(value)) {
    return invalidField(toolName, key);
  }

  return value;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function optionalPhone(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
): string | undefined | ActRefusal {
  const phone = optionalString(args, toolName, 'phone');

  if (isRefusal(phone) || phone === undefined) {
    return phone;
  }

  if (!parsePhone(phone)) {
    return refusal(
      'invalid_request',
      `${toolName} phone must look like +1 4155550134. Calling codes +1, +33, +44, +49, and +61 are accepted.`,
      { toolName },
    );
  }

  return phone;
}

function validateNote(args: Record<string, unknown>): ValidatedTool | ActRefusal {
  const body = requireNoteBody(args);

  if (typeof body !== 'string') {
    return body;
  }

  const title = optionalString(args, 'create_note', 'title');

  if (isRefusal(title)) {
    return title;
  }

  const targetObject = requireObjectName(args, 'create_note', 'targetObject');

  if (typeof targetObject !== 'string') {
    return targetObject;
  }

  const targetId = optionalRelationId(args, 'create_note', 'targetId');

  if (isRefusal(targetId)) {
    return targetId;
  }

  const targetQuery = optionalString(args, 'create_note', 'targetQuery');

  if (isRefusal(targetQuery)) {
    return targetQuery;
  }

  const useOpenRecord = readOpenRecordFlag(args, 'create_note');

  if (typeof useOpenRecord !== 'boolean') {
    return useOpenRecord;
  }

  if (!targetId && !targetQuery && !useOpenRecord) {
    return refusal(
      'missing_required_fields',
      'Refusing create_note: missing required fields: targetId.',
      { toolName: 'create_note', missingFields: ['targetId'] },
    );
  }

  if (targetQuery && !isSafeSearchQuery(targetQuery)) {
    return refusal(
      'invalid_request',
      'create_note targetQuery must be 1–80 letters, numbers, spaces, or . @ \' + -, with no filter syntax or LIKE wildcards.',
      { toolName: 'create_note' },
    );
  }

  return {
    name: 'create_note',
    input: {
      body,
      ...(title ? { title } : {}),
      targetObject,
      ...(targetId && !useOpenRecord ? { targetId } : {}),
      ...(targetQuery && !targetId && !useOpenRecord ? { targetQuery } : {}),
      ...(useOpenRecord ? { useOpenRecord: true } : {}),
    },
  };
}

function requireNoteBody(args: Record<string, unknown>): string | ActRefusal {
  const body = readString(args, 'body');

  if (body === 'invalid') {
    return invalidField('create_note', 'body');
  }

  if (!body) {
    return refusal(
      'missing_required_fields',
      'Refusing create_note: missing required fields: body.',
      { toolName: 'create_note', missingFields: ['body'] },
    );
  }

  if (body.length > MAX_NOTE_BODY) {
    return refusal(
      'invalid_request',
      'create_note body must be at most 4000 characters.',
      { toolName: 'create_note' },
    );
  }

  return body;
}

function requireObjectName(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
  key = 'object',
): UpdatableObjectName | ActRefusal {
  const objectName = requireString(args, toolName, key);

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

function optionalLimit(
  args: Record<string, unknown>,
  toolName: AllowedToolName = 'search_records',
): number | undefined | ActRefusal {
  if (!Object.prototype.hasOwnProperty.call(args, 'limit') || args.limit == null) {
    return undefined;
  }

  const limit = args.limit;

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    return refusal(
      'invalid_request',
      `${toolName} limit must be an integer from 1 to 20.`,
      { toolName },
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

  if (value.length > MAX_SHORT_TEXT) {
    return refusal(
      'invalid_request',
      'update_record value must be at most 200 characters.',
      { toolName: 'update_record' },
    );
  }

  if (objectName === 'opportunity' && field === 'stage') {
    const stage = canonicalOpportunityStage(value);

    if (!stage) {
      return refusal(
        'invalid_request',
        'update_record stage must be one of NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER.',
        { toolName: 'update_record' },
      );
    }

    return stage;
  }

  if (field === 'linkedin') {
    const linkedin = canonicalLinkedinUrl(value);

    if (!linkedin) {
      return refusal(
        'invalid_request',
        'update_record linkedin must be a linkedin.com profile URL, for example https://www.linkedin.com/in/ada.',
        { toolName: 'update_record' },
      );
    }

    return linkedin;
  }

  if (field === 'closeDate' && !isCalendarDate(value)) {
    return refusal(
      'invalid_request',
      'update_record closeDate must be a calendar date, YYYY-MM-DD.',
      { toolName: 'update_record' },
    );
  }

  if ((field === 'address' || field === 'city' || field === 'website' || field === 'domain') && /[\u0000-\u001f]/.test(value)) {
    return invalidField('update_record', 'value');
  }

  if (field === 'phone') {
    if (!parsePhone(value)) {
      return refusal(
        'invalid_request',
        'update_record phone must look like +1 4155550134. Calling codes +1, +33, +44, +49, and +61 are accepted.',
        { toolName: 'update_record' },
      );
    }

    return value;
  }

  if ((field === 'owner' || field === 'accountOwner') && !MEMBER_ID_PATTERN.test(value)) {
    return refusal(
      'invalid_request',
      'update_record owner must be "me" or a workspace member id.',
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

  if (trimmed.length > MAX_SHORT_TEXT) {
    return 'invalid';
  }

  return trimmed.length === 0 ? undefined : trimmed;
}

const TOOL_ARG_KEYS: Record<AllowedToolName, readonly string[]> = {
  create_person: ['firstName', 'lastName', 'email', 'jobTitle', 'phone', 'linkedin', 'companyId'],
  create_company: ['name', 'domain', 'website', 'linkedin', 'address', 'city'],
  create_opportunity: [
    'name',
    'amount',
    'currencyCode',
    'stage',
    'companyId',
    'pointOfContactId',
    'closeDate',
  ],
  create_note: ['title', 'body', 'targetObject', 'targetId', 'targetQuery', 'recordRef'],
  search_records: ['object', 'query', 'limit'],
  search_notes: ['query', 'limit'],
  search_tasks: ['query', 'limit'],
  search_activities: ['query', 'limit'],
  update_record: ['object', 'id', 'query', 'field', 'value', 'ifMatch', 'recordRef'],
  update_matching_records: ['object', 'query', 'field', 'value'],
  archive_record: ['object', 'id', 'query', 'ifMatch', 'recordRef'],
};

function rejectUnknownArgs(
  toolName: AllowedToolName,
  args: Record<string, unknown>,
): ActRefusal | undefined {
  for (const key of Object.keys(args)) {
    if (!TOOL_ARG_KEYS[toolName].includes(key)) {
      return refusal(
        'invalid_request',
        `${toolName} field "${key}" is not allowlisted.`,
        { toolName },
      );
    }
  }

  return undefined;
}

function readOpenRecordFlag(
  args: Record<string, unknown>,
  toolName: AllowedToolName,
): boolean | ActRefusal {
  if (!Object.prototype.hasOwnProperty.call(args, 'recordRef') || args.recordRef == null) {
    return false;
  }

  if (args.recordRef !== 'open') {
    return invalidField(toolName, 'recordRef');
  }

  return true;
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
