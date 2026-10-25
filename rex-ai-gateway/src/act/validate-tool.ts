import type {
  CreateCompanyInput,
  CreateOpportunityInput,
  CreatePersonInput,
} from '../twenty/twenty-crm-client';
import { isAllowedToolName } from './allowlist';
import { findForeignWorkspaceId } from './find-foreign-workspace-id';
import { refusal, type ActRefusal, type AllowedToolName, type ToolCall } from './types';

export type ValidatedTool =
  | { name: 'create_person'; input: Omit<CreatePersonInput, 'workspaceId'> }
  | { name: 'create_company'; input: Omit<CreateCompanyInput, 'workspaceId'> }
  | {
      name: 'create_opportunity';
      input: Omit<CreateOpportunityInput, 'workspaceId'>;
    };

const DEFAULT_OPPORTUNITY_STAGE = 'NEW';

export function validateTool(
  tool: ToolCall,
  requestWorkspaceId: string,
): ValidatedTool | ActRefusal {
  if (!isAllowedToolName(tool.name)) {
    return refusal(
      'unknown_tool',
      `Unknown tool "${tool.name}". Allowed tools: create_person, create_company, create_opportunity.`,
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

  const companyId = optionalString(args, 'create_person', 'companyId');
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

  const companyId = optionalString(args, 'create_opportunity', 'companyId');
  if (isRefusal(companyId)) {
    return companyId;
  }

  const pointOfContactId = optionalString(
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

// A present amount that is not a finite number >= 0 is refused. Never substitute 0.
function readNonNegativeAmount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
  }

  return undefined;
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
