import { parsePhone } from './parse-phone';
import { assertSafeSearchQuery, quoteFilterValue } from './safe-search';
import type {
  AddressFields,
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

export const TWENTY_CREATE_TARGET: Record<
  TwentyObjectName,
  TwentyCreateTarget
> = {
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

export function restSearchFilter(
  objectName: TwentyObjectName,
  query: string,
): string {
  const quoted = quoteFilterValue(`%${query}%`);

  if (objectName === 'person') {
    const clauses = [
      `name.firstName[ilike]:${quoted}`,
      `name.lastName[ilike]:${quoted}`,
      `emails.primaryEmail[ilike]:${quoted}`,
      ...personNameClauses(query),
    ];

    return `or(${clauses.join(',')})`;
  }

  return `name[ilike]:${quoted}`;
}

export function restTimelineSearchFilter(
  kind: 'note' | 'task' | 'activity',
  query: string,
): string {
  const quoted = quoteFilterValue(`%${query}%`);

  if (kind === 'activity') {
    return `linkedRecordCachedName[ilike]:${quoted}`;
  }

  return `or(title[ilike]:${quoted},bodyV2.markdown[ilike]:${quoted})`;
}

export function graphqlTimelineSearchFilter(
  kind: 'note' | 'task' | 'activity',
  query: string,
): Record<string, unknown> {
  const ilike = `%${query}%`;

  if (kind === 'activity') {
    return { linkedRecordCachedName: { ilike } };
  }

  return {
    or: [{ title: { ilike } }, { bodyV2: { markdown: { ilike } } }],
  };
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
        ...personNameGraphql(query),
      ],
    };
  }

  return { name: { ilike } };
}

// Twenty compares the whole string to one field. "Ada Lovelace" matches neither
// firstName nor lastName unless the two tokens are combined.
function personNameClauses(query: string): string[] {
  const parts = query
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return [];
  }

  const first = quoteFilterValue(`%${parts[0]}%`);
  const last = quoteFilterValue(`%${parts.slice(1).join(' ')}%`);

  return [`and(name.firstName[ilike]:${first},name.lastName[ilike]:${last})`];
}

function personNameGraphql(query: string): Record<string, unknown>[] {
  const parts = query
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return [];
  }

  return [
    {
      and: [
        { name: { firstName: { ilike: `%${parts[0]}%` } } },
        { name: { lastName: { ilike: `%${parts.slice(1).join(' ')}%` } } },
      ],
    },
  ];
}

const SAFE_FILTER_TOKEN = /^[A-Za-z0-9_.:T+Z-]{1,80}$/;

export function conditionalUpdateFilter(id: string, etag: string): string {
  if (!SAFE_FILTER_TOKEN.test(id) || !SAFE_FILTER_TOKEN.test(etag)) {
    throw new Error(
      'Refusing to interpolate an unsafe id or etag into a Twenty filter.',
    );
  }

  return `and(id[eq]:"${id}",updatedAt[eq]:"${etag}")`;
}

export function domainHostKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

const DOMAIN_HOST_PREFIXES = [
  'https://',
  'http://',
  'https://www.',
  'http://www.',
  '',
] as const;

export function restDomainHostFilter(host: string): string {
  assertSafeSearchQuery(host);
  const clauses = DOMAIN_HOST_PREFIXES.map(
    (prefix) =>
      `domainName.primaryLinkUrl[eq]:${JSON.stringify(prefix + host)}`,
  );

  return `or(${clauses.join(',')})`;
}

export function graphqlDomainHostFilter(host: string): Record<string, unknown> {
  assertSafeSearchQuery(host);

  return {
    or: DOMAIN_HOST_PREFIXES.map((prefix) => ({
      domainName: { primaryLinkUrl: { eq: prefix + host } },
    })),
  };
}

export function companyIdEqualsFilter(companyId: string): string {
  assertFilterToken(companyId, 'company id');

  return `companyId[eq]:"${companyId}"`;
}

export function restTimelineRecordFilter(
  kind: 'note' | 'task' | 'activity',
  recordId: string,
): string {
  assertFilterToken(recordId, 'record id');
  const id = JSON.stringify(recordId);

  if (kind === 'activity') {
    return `linkedRecordId[eq]:${id}`;
  }

  const prefix = kind === 'note' ? 'noteTargets' : 'taskTargets';

  return `or(${prefix}.targetPersonId[eq]:${id},${prefix}.targetCompanyId[eq]:${id},${prefix}.targetOpportunityId[eq]:${id})`;
}

export function graphqlTimelineRecordFilter(
  kind: 'note' | 'task' | 'activity',
  recordId: string,
): Record<string, unknown> {
  assertFilterToken(recordId, 'record id');

  if (kind === 'activity') {
    return { linkedRecordId: { eq: recordId } };
  }

  const target = {
    or: [
      { targetPersonId: { eq: recordId } },
      { targetCompanyId: { eq: recordId } },
      { targetOpportunityId: { eq: recordId } },
    ],
  };

  return kind === 'note' ? { noteTargets: target } : { taskTargets: target };
}

function assertFilterToken(value: string, label: string): void {
  if (!SAFE_FILTER_TOKEN.test(value)) {
    throw new Error(
      `Refusing to interpolate an unsafe ${label} into a Twenty filter.`,
    );
  }
}

export function updateManyName(objectName: TwentyObjectName): string {
  const plural = TWENTY_OBJECT_PATH[objectName].plural;

  return `update${plural.charAt(0).toUpperCase()}${plural.slice(1)}`;
}

export function deleteManyName(objectName: TwentyObjectName): string {
  const plural = TWENTY_OBJECT_PATH[objectName].plural;

  return `delete${plural.charAt(0).toUpperCase()}${plural.slice(1)}`;
}

export function restoreManyName(objectName: TwentyObjectName): string {
  const deleted = deleteManyName(objectName);

  return `restore${deleted.slice('delete'.length)}`;
}

export function toClearPayload(
  objectName: TwentyObjectName,
  field: string,
  current: Record<string, string | number>,
  composites?: RecordComposites,
): Record<string, unknown> {
  if (
    objectName === 'person' &&
    (field === 'firstName' || field === 'lastName')
  ) {
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

  if (objectName === 'company' && (field === 'domain' || field === 'website')) {
    return {
      domainName: {
        primaryLinkUrl: '',
        primaryLinkLabel: composites?.primaryLinkLabel ?? '',
        secondaryLinks: composites?.secondaryLinks ?? [],
      },
    };
  }

  if (
    (objectName === 'person' || objectName === 'company') &&
    field === 'linkedin'
  ) {
    return {
      linkedinLink: {
        primaryLinkUrl: '',
        primaryLinkLabel: composites?.linkedinLabel ?? '',
        secondaryLinks: composites?.linkedinSecondaryLinks ?? [],
      },
    };
  }

  if (objectName === 'company' && (field === 'address' || field === 'city')) {
    return {
      address: addressPayload(composites?.address, field, ''),
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
        currencyCode:
          typeof current.currencyCode === 'string'
            ? current.currencyCode
            : 'USD',
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
  if (
    objectName === 'person' &&
    (field === 'firstName' || field === 'lastName')
  ) {
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

  if (
    objectName === 'company' &&
    (field === 'domain' || field === 'website') &&
    typeof value === 'string'
  ) {
    return {
      domainName: {
        primaryLinkUrl: toCompanyLinkUrl(value),
        primaryLinkLabel: composites?.primaryLinkLabel ?? '',
        secondaryLinks: composites?.secondaryLinks ?? [],
      },
    };
  }

  if (
    (objectName === 'person' || objectName === 'company') &&
    field === 'linkedin' &&
    typeof value === 'string'
  ) {
    return {
      linkedinLink: {
        primaryLinkUrl: value,
        primaryLinkLabel: composites?.linkedinLabel ?? '',
        secondaryLinks: composites?.linkedinSecondaryLinks ?? [],
      },
    };
  }

  if (
    objectName === 'company' &&
    (field === 'address' || field === 'city') &&
    typeof value === 'string'
  ) {
    return {
      address: addressPayload(composites?.address, field, value),
    };
  }

  if (
    objectName === 'person' &&
    field === 'phone' &&
    typeof value === 'string'
  ) {
    const phone = parsePhone(value);

    if (!phone) {
      throw new Error(
        'Refusing to write a phone number the gateway did not parse.',
      );
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

  if (
    objectName === 'company' &&
    field === 'accountOwner' &&
    typeof value === 'string'
  ) {
    return { accountOwnerId: value };
  }

  if (
    objectName === 'opportunity' &&
    field === 'owner' &&
    typeof value === 'string'
  ) {
    return { ownerId: value };
  }

  if (
    objectName === 'opportunity' &&
    field === 'amount' &&
    typeof value === 'number'
  ) {
    return {
      amount: {
        amountMicros: toAmountMicros(value),
        currencyCode:
          typeof current.currencyCode === 'string'
            ? current.currencyCode
            : 'USD',
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

  if (input.linkedin) {
    payload.linkedinLink = {
      primaryLinkUrl: input.linkedin,
      primaryLinkLabel: '',
      secondaryLinks: [],
    };
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

  if (input.linkedin) {
    payload.linkedinLink = {
      primaryLinkUrl: input.linkedin,
      primaryLinkLabel: '',
      secondaryLinks: [],
    };
  }

  if (input.address || input.city) {
    payload.address = {
      ...(input.address ? { addressStreet1: input.address } : {}),
      ...(input.city ? { addressCity: input.city } : {}),
    };
  }

  return payload;
}

function addressPayload(
  current: AddressFields | undefined,
  field: 'address' | 'city',
  value: string,
): AddressFields {
  return {
    addressStreet1:
      field === 'address' ? value : (current?.addressStreet1 ?? ''),
    addressStreet2: current?.addressStreet2 ?? '',
    addressCity: field === 'city' ? value : (current?.addressCity ?? ''),
    addressState: current?.addressState ?? '',
    addressPostcode: current?.addressPostcode ?? '',
    addressCountry: current?.addressCountry ?? '',
  };
}

export const RECORD_GRAPHQL_FIELDS: Record<TwentyObjectName, string> = {
  person:
    'id updatedAt jobTitle companyId name { firstName lastName } emails { primaryEmail additionalEmails } phones { primaryPhoneNumber primaryPhoneCallingCode } linkedinLink { primaryLinkUrl primaryLinkLabel secondaryLinks }',
  company:
    'id updatedAt name accountOwnerId domainName { primaryLinkUrl primaryLinkLabel secondaryLinks } linkedinLink { primaryLinkUrl primaryLinkLabel secondaryLinks } address { addressStreet1 addressStreet2 addressCity addressState addressPostcode addressCountry }',
  opportunity:
    'id updatedAt name stage closeDate companyId pointOfContactId ownerId amount { amountMicros currencyCode }',
};

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
