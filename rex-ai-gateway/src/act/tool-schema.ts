import { ALLOWED_TOOL_NAMES } from './types';
import { UPDATABLE_FIELDS } from './writable-fields';

export type ToolSchema = {
  name: (typeof ALLOWED_TOOL_NAMES)[number];
  description: string;
  inputSchema: Record<string, unknown>;
};

const stringProperty = (description: string) => ({
  type: 'string',
  description,
});

export function toolCatalog(): { tools: ToolSchema[] } {
  return {
    tools: [
      {
        name: 'create_person',
        description:
          'Create a person. firstName and lastName are required. companyId may be a record id or $n, where n is the index of an earlier create or update in the same request.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
          required: ['firstName', 'lastName'],
          properties: {
            firstName: stringProperty('Given name.'),
            lastName: stringProperty('Family name.'),
            email: stringProperty('Primary email. Fictional addresses only in examples.'),
            jobTitle: stringProperty('Job title.'),
            companyId: stringProperty('Company record id, or $n for an earlier tool result.'),
          },
        },
      },
      {
        name: 'create_company',
        description: 'Create a company. name is required.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
          required: ['name'],
          properties: {
            name: stringProperty('Company name.'),
            domain: stringProperty('Domain or URL, stored as a link.'),
          },
        },
      },
      {
        name: 'create_opportunity',
        description:
          'Create an opportunity. name is required. amount is major currency units, not micros. stage defaults to NEW. companyId and pointOfContactId accept a record id or $n.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
          required: ['name'],
          properties: {
            name: stringProperty('Opportunity name.'),
            amount: { type: 'number', minimum: 0, description: 'Amount in major units.' },
            currencyCode: stringProperty('ISO currency code. Defaults to USD when amount is set.'),
            stage: stringProperty('Stage. Defaults to NEW.'),
            companyId: stringProperty('Company record id, or $n.'),
            pointOfContactId: stringProperty('Person record id, or $n.'),
            closeDate: stringProperty('Close date, YYYY-MM-DD.'),
          },
        },
      },
      {
        name: 'search_records',
        description:
          'Find people, companies, or opportunities by a case-insensitive name, email, or domain fragment. Read-only.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
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
          'Update one allowlisted field. ifMatch is the record etag from search or get (If-Match). A mismatch does not write. Writable fields: ' +
          Object.entries(UPDATABLE_FIELDS)
            .map(([objectName, fields]) => `${objectName} (${fields.join(', ')})`)
            .join('; ') +
          '.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
          required: ['object', 'id', 'field', 'value', 'ifMatch'],
          properties: {
            object: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
            },
            id: stringProperty('Record id from this workspace.'),
            field: stringProperty('One writable field for that object.'),
            value: {
              description: 'New value. amount is a number. Every other field is a string.',
            },
            ifMatch: stringProperty('Current etag. The write is refused when it does not match.'),
          },
        },
      },
    ],
  };
}
