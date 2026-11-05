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
            phone: stringProperty('Primary phone, for example +1 4155550134.'),
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
          additionalProperties: true,
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
          'Update one allowlisted field. id or query is required. ifMatch is the record etag (If-Match). A mismatch does not write. owner and accountOwner accept "me" or a workspace member id. stage must be NEW, SCREENING, MEETING, PROPOSAL, or CUSTOMER. phone looks like +1 4155550134. Writable fields: ' +
          Object.entries(UPDATABLE_FIELDS)
            .map(([objectName, fields]) => `${objectName} (${fields.join(', ')})`)
            .join('; ') +
          '.',
        inputSchema: {
          type: 'object',
          additionalProperties: true,
          required: ['object', 'field', 'value'],
          properties: {
            object: {
              type: 'string',
              enum: ['person', 'company', 'opportunity'],
            },
            id: stringProperty('Record id from this workspace. Omit when query is set.'),
            query: stringProperty('Name fragment when the id is not known. Several matches become choices.'),
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
