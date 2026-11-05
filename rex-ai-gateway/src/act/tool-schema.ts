import type { TwentyObjectName } from '../twenty/twenty-crm-client';
import { ALLOWED_TOOL_NAMES } from './types';
import { UPDATABLE_FIELDS } from './writable-fields';

export type ToolSchema = {
  name: (typeof ALLOWED_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolAudience = {
  canRead: ReadonlySet<TwentyObjectName>;
  canCreate: ReadonlySet<TwentyObjectName | 'note'>;
  canUpdate: ReadonlySet<TwentyObjectName | 'note'>;
  canSoftDelete: ReadonlySet<TwentyObjectName | 'note'>;
};

const stringProperty = (description: string) => ({
  type: 'string',
  description,
});

export function toolCatalog(audience?: ToolAudience): { tools: ToolSchema[] } {
  const tools = fullCatalog();

  if (!audience) {
    return { tools };
  }

  return { tools: tools.filter((tool) => isVisible(tool, audience)).map((tool) => narrow(tool, audience)) };
}

function fullCatalog(): ToolSchema[] {
  return [
      {
        name: 'create_person',
        description:
          'Create a person. firstName and lastName are required. companyId may be a record id or $n, where n is the index of an earlier create or update in the same request.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['firstName', 'lastName'],
          properties: {
            firstName: stringProperty('Given name.'),
            lastName: stringProperty('Family name.'),
            email: stringProperty('Primary email. Fictional addresses only in examples.'),
            jobTitle: stringProperty('Job title.'),
            phone: stringProperty('Primary phone, for example +1 4155550134.'),
            linkedin: stringProperty('LinkedIn profile URL, for example https://www.linkedin.com/in/ada.'),
            companyId: stringProperty('Company record id, or $n for an earlier tool result.'),
          },
        },
      },
      {
        name: 'create_company',
        description: 'Create a company. name is required.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: stringProperty('Company name.'),
            domain: stringProperty('Website domain or URL, stored as a link. Same field as website.'),
            website: stringProperty('Company website. Same link as domain.'),
            linkedin: stringProperty('Company LinkedIn URL, for example https://www.linkedin.com/company/acme.'),
            address: stringProperty('Street address.'),
            city: stringProperty('City.'),
          },
        },
      },
      {
        name: 'create_opportunity',
        description:
          'Create an opportunity. name is required. amount is major currency units, not micros. stage defaults to NEW. companyId and pointOfContactId accept a record id or $n.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: stringProperty('Opportunity name.'),
            amount: { type: 'number', minimum: 0, description: 'Amount in major units.' },
            currencyCode: stringProperty('ISO currency code. Defaults to USD when amount is set.'),
            stage: stringProperty(
              'One of NEW, SCREENING, MEETING, PROPOSAL, CUSTOMER. Defaults to NEW.',
            ),
            companyId: stringProperty('Company record id, or $n.'),
            pointOfContactId: stringProperty('Person record id, or $n.'),
            closeDate: stringProperty('Close date, YYYY-MM-DD.'),
          },
        },
      },
      {
        name: 'create_note',
        description:
          'Add a note to one person, company, or opportunity. body is markdown. targetId may be a record id or $n. targetQuery names the record when the id is not known; several matches become choices.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['body', 'targetObject'],
          properties: {
            title: stringProperty('Note title. Defaults to Note.'),
            body: stringProperty('Note body, at most 4000 characters.'),
            targetObject: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
            },
            targetId: stringProperty('Record id, or $n for an earlier tool result.'),
            targetQuery: stringProperty('Name to search when targetId is omitted.'),
            recordRef: {
              type: 'string',
              description:
                'open for the record on screen, or a visible-record handle such as p1, c1, or o1. Do not send an id.',
            },
          },
        },
      },
      {
        name: 'search_records',
        description:
          'Find people, companies, or opportunities by a case-insensitive name, email, or domain fragment. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['object', 'query'],
          properties: {
            object: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
              description: 'Object to search.',
            },
            query: stringProperty('Text to match. 1–80 characters, without filter punctuation or wildcards.'),
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              description: 'Maximum matches. Defaults to 10.',
            },
          },
        },
      },
      {
        name: 'update_record',
        description:
          'Update one allowlisted field. id or query is required. ifMatch is the record etag (If-Match). A mismatch does not write. owner and accountOwner accept "me" or a workspace member id. stage must be NEW, SCREENING, MEETING, PROPOSAL, or CUSTOMER. phone looks like +1 4155550134. Writable fields: ' +
          Object.entries(UPDATABLE_FIELDS)
            .map(([objectName, fields]) => `${objectName} (${fields.join(', ')})`)
            .join('; ') +
          '.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['object', 'field', 'value'],
          properties: {
            object: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
            },
            id: stringProperty('Record id from this workspace. Omit when query or recordRef is set.'),
            query: stringProperty('Name fragment when the id is not known. Several matches become choices.'),
            field: stringProperty('One writable field for that object.'),
            value: {
              description: 'New value. amount is a number. Every other field is a string.',
            },
            ifMatch: stringProperty('Current etag. The write is refused when it does not match.'),
            recordRef: {
              type: 'string',
              description:
                'open for the record on screen, or a visible-record handle such as p1, c1, or o1. Do not send an id.',
            },
          },
        },
      },
      {
        name: 'archive_record',
        description:
          'Soft-delete one person, company, or opportunity. Twenty keeps the row and sets deleted at. id, query, or recordRef is required. ifMatch is the record etag. Hard delete is not available.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['object'],
          properties: {
            object: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
            },
            id: stringProperty('Record id from this workspace. Omit when query or recordRef is set.'),
            query: stringProperty('Name fragment when the id is not known. Several matches become choices.'),
            ifMatch: stringProperty('Current etag. The archive is refused when it does not match.'),
            recordRef: {
              type: 'string',
              description:
                'open for the record on screen, or a visible-record handle such as p1, c1, or o1. Do not send an id.',
            },
          },
        },
      },
  ];
}

function isVisible(tool: ToolSchema, audience: ToolAudience): boolean {
  switch (tool.name) {
    case 'create_person':
      return audience.canCreate.has('person');
    case 'create_company':
      return audience.canCreate.has('company');
    case 'create_opportunity':
      return audience.canCreate.has('opportunity');
    case 'create_note':
      return audience.canCreate.has('note') && readableNames(audience).length > 0;
    case 'search_records':
      return readableNames(audience).length > 0;
    case 'update_record':
      return updatableNames(audience).length > 0;
    case 'archive_record':
      return archivableNames(audience).length > 0;
  }
}

function narrow(tool: ToolSchema, audience: ToolAudience): ToolSchema {
  if (tool.name === 'search_records') {
    return withEnum(tool, 'object', readableNames(audience));
  }

  if (tool.name === 'update_record') {
    return withEnum(tool, 'object', updatableNames(audience));
  }

  if (tool.name === 'archive_record') {
    return withEnum(tool, 'object', archivableNames(audience));
  }

  if (tool.name === 'create_note') {
    return withEnum(tool, 'targetObject', readableNames(audience));
  }

  return tool;
}

function withEnum(tool: ToolSchema, key: string, values: string[]): ToolSchema {
  const properties = isProperties(tool.inputSchema.properties)
    ? { ...tool.inputSchema.properties }
    : {};
  const current = properties[key];
  properties[key] = isProperties(current) ? { ...current, enum: values } : { type: 'string', enum: values };

  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

function readableNames(audience: ToolAudience): TwentyObjectName[] {
  return (['person', 'company', 'opportunity'] as const).filter((name) => audience.canRead.has(name));
}

function updatableNames(audience: ToolAudience): TwentyObjectName[] {
  return (['person', 'company', 'opportunity'] as const).filter(
    (name) => audience.canRead.has(name) && audience.canUpdate.has(name),
  );
}

function archivableNames(audience: ToolAudience): TwentyObjectName[] {
  return (['person', 'company', 'opportunity'] as const).filter(
    (name) => audience.canRead.has(name) && audience.canSoftDelete.has(name),
  );
}

function isProperties(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
