import type { CreatedRecord } from '../twenty/twenty-crm-client';
import type { ToolCall } from './types';
import type { PendingChoice } from './pending-choice';

export const CREATE_NEW_CHOICE_ID = 'create_new';

type ChoiceDraft = Omit<PendingChoice, 'candidates' | 'createTools' | 'query'> & {
  query: string;
};

export function matchDetail(record: CreatedRecord): string {
  if (record.objectName === 'opportunity') {
    const parts: string[] = [];
    const stage = record.properties.stage;
    const amount = record.properties.amount;

    if (typeof stage === 'string') {
      parts.push(stage);
    }

    if (typeof amount === 'number') {
      const currency =
        typeof record.properties.currencyCode === 'string' ? record.properties.currencyCode : 'USD';
      parts.push(currency === 'USD' ? `$${amount.toLocaleString('en-US')}` : `${amount.toLocaleString('en-US')} ${currency}`);
    }

    return parts.join(' · ');
  }

  const parts: string[] = [];
  const email = record.properties.email;
  const domain = record.properties.domain ?? record.properties.website;
  const city = record.properties.city;

  if (typeof email === 'string') {
    parts.push(email);
  }

  if (typeof domain === 'string') {
    parts.push(domain);
  }

  if (typeof city === 'string') {
    parts.push(city);
  }

  return parts.join(' · ');
}

export function matchLabel(record: CreatedRecord): string {
  return record.label;
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
      (choice.field === 'email' ||
        choice.field === 'jobTitle' ||
        choice.field === 'phone' ||
        choice.field === 'linkedin') &&
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

  if ((choice.field === 'domain' || choice.field === 'website') && typeof choice.value === 'string') {
    return [{ name: 'create_company', args: { name: choice.query, domain: choice.value } }];
  }

  if (
    (choice.field === 'linkedin' || choice.field === 'address' || choice.field === 'city') &&
    typeof choice.value === 'string'
  ) {
    return [
      { name: 'create_company', args: { name: choice.query, [choice.field]: choice.value } },
    ];
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
