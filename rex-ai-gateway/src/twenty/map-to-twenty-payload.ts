import type {
  CreateCompanyInput,
  CreateOpportunityInput,
  CreatePersonInput,
  TwentyObjectName,
} from './twenty-crm-client';

export type TwentyCreateTarget = {
  restPath: string;
  mutationName: string;
  inputType: string;
};

export const TWENTY_CREATE_TARGET: Record<TwentyObjectName, TwentyCreateTarget> =
  {
    person: {
      restPath: '/rest/people',
      mutationName: 'createPerson',
      inputType: 'PersonCreateInput',
    },
    company: {
      restPath: '/rest/companies',
      mutationName: 'createCompany',
      inputType: 'CompanyCreateInput',
    },
    opportunity: {
      restPath: '/rest/opportunities',
      mutationName: 'createOpportunity',
      inputType: 'OpportunityCreateInput',
    },
  };

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
  return Math.round(amount * 1_000_000);
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
