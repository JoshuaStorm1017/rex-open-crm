import { parsePhone } from './parse-phone';
import { quoteFilterValue } from './safe-search';
import type {
  CreateCompanyInput,
  CreateOpportunityInput,
  CreatePersonInput,
  RecordComposites,
  TwentyObjectName,
} from './twenty-crm-client';

export const TWENTY_OBJECT_PATH = {
  person: {
    restPath: '/rest/people',
    singular: 'person',
    plural: 'people',
    mutationName: 'createPerson',
    updateMutationName: 'updatePerson',
    inputType: 'PersonCreateInput',
    updateInputType: 'PersonUpdateInput',
    filterInputType: 'PersonFilterInput',
  },
  company: {
    restPath: '/rest/companies',
    singular: 'company',
    plural: 'companies',
    mutationName: 'createCompany',
    updateMutationName: 'updateCompany',
    inputType: 'CompanyCreateInput',
    updateInputType: 'CompanyUpdateInput',
    filterInputType: 'CompanyFilterInput',
  },
  opportunity: {
    restPath: '/rest/opportunities',
    singular: 'opportunity',
    plural: 'opportunities',
    mutationName: 'createOpportunity',
    updateMutationName: 'updateOpportunity',
    inputType: 'OpportunityCreateInput',
    updateInputType: 'OpportunityUpdateInput',
    filterInputType: 'OpportunityFilterInput',
  },
} as const satisfies Record<
  TwentyObjectName,
  {
    restPath: string;
    singular: string;
    plural: string;
    mutationName: string;
    updateMutationName: string;
    inputType: string;
    updateInputType: string;
    filterInputType: string;
  }
>;

export type TwentyCreateTarget = {
  restPath: string;
  mutationName: string;
  inputType: string;
};

export const TWENTY_CREATE_TARGET: Record<TwentyObjectName, TwentyCreateTarget> =
  {
    person: {
      restPath: TWENTY_OBJECT_PATH.person.restPath,
      mutationName: TWENTY_OBJECT_PATH.person.mutationName,
      inputType: TWENTY_OBJECT_PATH.person.inputType,
    },
    company: {
      restPath: TWENTY_OBJECT_PATH.company.restPath,
      mutationName: TWENTY_OBJECT_PATH.company.mutationName,
      inputType: TWENTY_OBJECT_PATH.company.inputType,
    },
    opportunity: {
      restPath: TWENTY_OBJECT_PATH.opportunity.restPath,
      mutationName: TWENTY_OBJECT_PATH.opportunity.mutationName,
      inputType: TWENTY_OBJECT_PATH.opportunity.inputType,
    },
  };

export function restSearchFilter(objectName: TwentyObjectName, query: string): string {
  const quoted = quoteFilterValue(`%${query}%`);

  if (objectName === 'person') {
    return `or(name.firstName[ilike]:${quoted},name.lastName[ilike]:${quoted},emails.primaryEmail[ilike]:${quoted})`;
  }

  return `name[ilike]:${quoted}`;
}

export function graphqlSearchFilter(
  objectName: TwentyObjectName,
  query: string,
): Record<string, unknown> {
  const ilike = `%${query}%`;

  if (objectName === 'person') {
    return {
      or: [
        { name: { firstName: { ilike } } },
        { name: { lastName: { ilike } } },
        { emails: { primaryEmail: { ilike } } },
      ],
    };
  }

  return { name: { ilike } };
}

const SAFE_FILTER_TOKEN = /^[A-Za-z0-9_.:T+Z-]{1,80}$/;

export function conditionalUpdateFilter(id: string, etag: string): string {
  if (!SAFE_FILTER_TOKEN.test(id) || !SAFE_FILTER_TOKEN.test(etag)) {
    throw new Error('Refusing to interpolate an unsafe id or etag into a Twenty filter.');
  }

  return `and(id[eq]:"${id}",updatedAt[eq]:"${etag}")`;
}

export function updateManyName(objectName: TwentyObjectName): string {
  const plural = TWENTY_OBJECT_PATH[objectName].plural;

  return `update${plural.charAt(0).toUpperCase()}${plural.slice(1)}`;
}

export function toClearPayload(
  objectName: TwentyObjectName,
  field: string,
  current: Record<string, string | number>,
  composites?: RecordComposites,
): Record<string, unknown> {
  if (objectName === 'person' && (field === 'firstName' || field === 'lastName')) {
    return {
      name: {
        firstName: field === 'firstName' ? '' : (current.firstName ?? ''),
        lastName: field === 'lastName' ? '' : (current.lastName ?? ''),
      },
    };
  }

  if (objectName === 'person' && field === 'email') {
    return {
      emails: {
        primaryEmail: '',
        additionalEmails: composites?.additionalEmails ?? [],
      },
    };
  }

  if (objectName === 'company' && field === 'domain') {
    return {
      domainName: {
        primaryLinkUrl: '',
        primaryLinkLabel: composites?.primaryLinkLabel ?? '',
        secondaryLinks: composites?.secondaryLinks ?? [],
      },
    };
  }

  if (objectName === 'person' && field === 'phone') {
    return {
      phones: {
        primaryPhoneNumber: '',
        primaryPhoneCountryCode: '',
        primaryPhoneCallingCode: '',
        additionalPhones: [],
      },
    };
  }

  if (objectName === 'company' && field === 'accountOwner') {
    return { accountOwnerId: null };
  }

  if (objectName === 'opportunity' && field === 'owner') {
    return { ownerId: null };
  }

  if (objectName === 'opportunity' && field === 'amount') {
    return {
      amount: {
        amountMicros: null,
        currencyCode: typeof current.currencyCode === 'string' ? current.currencyCode : 'USD',
      },
    };
  }

  return { [field]: null };
}

export function toUpdatePayload(
  objectName: TwentyObjectName,
  field: string,
  value: string | number,
  current: Record<string, string | number>,
  composites?: RecordComposites,
): Record<string, unknown> {
  if (objectName === 'person' && (field === 'firstName' || field === 'lastName')) {
    return {
      name: {
        firstName: field === 'firstName' ? value : (current.firstName ?? ''),
        lastName: field === 'lastName' ? value : (current.lastName ?? ''),
      },
    };
  }

  if (objectName === 'person' && field === 'email') {
    return {
      emails: {
        primaryEmail: value,
        additionalEmails: composites?.additionalEmails ?? [],
      },
    };
  }

  if (objectName === 'company' && field === 'domain' && typeof value === 'string') {
    return {
      domainName: {
        primaryLinkUrl: toCompanyLinkUrl(value),
        primaryLinkLabel: composites?.primaryLinkLabel ?? '',
        secondaryLinks: composites?.secondaryLinks ?? [],
      },
    };
  }

  if (objectName === 'person' && field === 'phone' && typeof value === 'string') {
    const phone = parsePhone(value);

    if (!phone) {
      throw new Error('Refusing to write a phone number the gateway did not parse.');
    }

    return {
      phones: {
        primaryPhoneNumber: phone.number,
        primaryPhoneCountryCode: phone.countryCode,
        primaryPhoneCallingCode: phone.callingCode,
        additionalPhones: [],
      },
    };
  }

  if (objectName === 'company' && field === 'accountOwner' && typeof value === 'string') {
    return { accountOwnerId: value };
  }

  if (objectName === 'opportunity' && field === 'owner' && typeof value === 'string') {
    return { ownerId: value };
  }

  if (objectName === 'opportunity' && field === 'amount' && typeof value === 'number') {
    return {
      amount: {
        amountMicros: toAmountMicros(value),
        currencyCode:
          typeof current.currencyCode === 'string' ? current.currencyCode : 'USD',
      },
    };
  }

  return { [field]: value };
}

export function toPersonPayload(
  input: CreatePersonInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: {
      firstName: input.firstName,
      lastName: input.lastName,
    },
  };

  if (input.email) {
    payload.emails = {
      primaryEmail: input.email,
      additionalEmails: [],
    };
  }

  if (input.jobTitle) {
    payload.jobTitle = input.jobTitle;
  }

  if (input.phone) {
    const phone = parsePhone(input.phone);

    if (phone) {
      payload.phones = {
        primaryPhoneNumber: phone.number,
        primaryPhoneCountryCode: phone.countryCode,
        primaryPhoneCallingCode: phone.callingCode,
        additionalPhones: [],
      };
    }
  }

  if (input.companyId) {
    payload.companyId = input.companyId;
  }

  return payload;
}

// Twenty's links composite stores a URL. A bare domain is rejected by that field.
export function toCompanyLinkUrl(domain: string): string {
  if (/^https?:\/\//i.test(domain)) {
    return domain;
  }

  return `https://${domain}`;
}

export function toCompanyPayload(
  input: CreateCompanyInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
  };

  if (input.domain) {
    payload.domainName = {
      primaryLinkUrl: toCompanyLinkUrl(input.domain),
      primaryLinkLabel: '',
      secondaryLinks: [],
    };
  }

  return payload;
}

// Twenty stores currency as micros (1 major unit = 1_000_000).
export function toAmountMicros(amount: number): number {
  const micros = Math.round(amount * 1_000_000);

  if (!Number.isSafeInteger(micros)) {
    throw new Error('amount is too large to store as micros.');
  }

  return micros;
}

export function toOpportunityPayload(
  input: CreateOpportunityInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
    stage: input.stage,
  };

  if (input.amount !== undefined) {
    payload.amount = {
      amountMicros: toAmountMicros(input.amount),
      currencyCode: input.currencyCode ?? 'USD',
    };
  }

  if (input.companyId) {
    payload.companyId = input.companyId;
  }

  if (input.pointOfContactId) {
    payload.pointOfContactId = input.pointOfContactId;
  }

  if (input.closeDate) {
    payload.closeDate = input.closeDate;
  }

  return payload;
}
