import type { CreatedRecord } from '../twenty/twenty-crm-client';
import type { ToolCall } from './types';
import type { PendingChoice } from './pending-choice';

export const CREATE_NEW_CHOICE_ID = 'create_new';

type ChoiceDraft = Omit<PendingChoice, 'candidates' | 'createTools' | 'query'> & {
  query: string;
};

export function matchLabel(record: CreatedRecord): string {
  const email = record.properties.email;
  const domain = record.properties.domain;
  const detail =
    typeof email === 'string' ? email : typeof domain === 'string' ? domain : undefined;

  return detail ? `${record.label} · ${detail}` : record.label;
}

export function createNewTools(choice: ChoiceDraft): ToolCall[] | undefined {
  if (choice.objectName !== 'person' && choice.objectName !== 'company') {
    return undefined;
  }

  if (choice.kind === 'note') {
    const created = recordFromQuery(choice.objectName, choice.query);

    if (!created) {
      return undefined;
    }

    return [
      created,
      {
        name: 'create_note',
        args: {
          ...(choice.title ? { title: choice.title } : {}),
          body: choice.body,
          targetObject: choice.objectName,
          targetId: '$0',
        },
      },
    ];
  }

  return updateAsCreate(choice);
}

export function createNewLabel(choice: ChoiceDraft): string {
  if (choice.kind === 'note') {
    return `Create new ${choice.objectName} “${choice.query}” and add the note`;
  }

  if (choice.objectName === 'company' && choice.field === 'name' && typeof choice.value === 'string') {
    return `Create new company “${choice.value}”`;
  }

  return `Create new ${choice.objectName} “${choice.query}” and set ${choice.field}`;
}

function updateAsCreate(choice: ChoiceDraft): ToolCall[] | undefined {
  if (choice.objectName === 'person') {
    const names = personNames(choice.query);

    if (choice.field === 'firstName' && typeof choice.value === 'string') {
      names.firstName = choice.value;
    }

    if (choice.field === 'lastName' && typeof choice.value === 'string') {
      names.lastName = choice.value;
    }

    const args: Record<string, unknown> = { ...names };

    if (
      (choice.field === 'email' || choice.field === 'jobTitle' || choice.field === 'phone') &&
      typeof choice.value === 'string'
    ) {
      args[choice.field] = choice.value;
    }

    if (choice.field === 'firstName' || choice.field === 'lastName' || choice.field in args) {
      return [{ name: 'create_person', args }];
    }

    return undefined;
  }

  if (choice.field === 'name' && typeof choice.value === 'string') {
    return [{ name: 'create_company', args: { name: choice.value } }];
  }

  if (choice.field === 'domain' && typeof choice.value === 'string') {
    return [{ name: 'create_company', args: { name: choice.query, domain: choice.value } }];
  }

  if (choice.field === 'accountOwner' && typeof choice.value === 'string') {
    // The new company's etag does not exist until the create commits.
    return [
      { name: 'create_company', args: { name: choice.query } },
      {
        name: 'update_record',
        args: {
          object: 'company',
          id: '$0',
          field: 'accountOwner',
          value: choice.value,
          ifMatch: 'created',
        },
      },
    ];
  }

  return undefined;
}

function recordFromQuery(
  objectName: 'person' | 'company',
  query: string,
): ToolCall | undefined {
  if (objectName === 'company') {
    return { name: 'create_company', args: { name: query } };
  }

  return { name: 'create_person', args: personNames(query) };
}

function personNames(query: string): { firstName: string; lastName: string } {
  const parts = query.trim().split(/\s+/).filter((part) => part.length > 0);

  if (parts.length >= 2) {
    return { firstName: parts[0] ?? 'New', lastName: parts.slice(1).join(' ') };
  }

  return { firstName: parts[0] ?? 'New', lastName: 'Unknown' };
}
