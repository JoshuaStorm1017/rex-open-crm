export type CreatePersonInput = {
  workspaceId: string;
  firstName: string;
  lastName: string;
  email?: string;
  jobTitle?: string;
  companyId?: string;
};

export type CreateCompanyInput = {
  workspaceId: string;
  name: string;
  domain?: string;
};

export type CreateOpportunityInput = {
  workspaceId: string;
  name: string;
  stage: string;
  amount?: number;
  currencyCode?: string;
  companyId?: string;
  pointOfContactId?: string;
  closeDate?: string;
};

export type TwentyObjectName = 'person' | 'company' | 'opportunity';

export type CreatedRecord = {
  id: string;
  objectName: TwentyObjectName;
  workspaceId: string;
  properties: Record<string, string | number>;
  etag: string;
  label: string;
};

export type SearchRecordsInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  query: string;
  limit: number;
};

export type GetRecordInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  id: string;
};

export type UpdateRecordInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  id: string;
  field: string;
  value: string | number;
  ifMatch: string;
};

export type TwentyCrmClient = {
  createPerson: (input: CreatePersonInput) => Promise<CreatedRecord>;
  createCompany: (input: CreateCompanyInput) => Promise<CreatedRecord>;
  createOpportunity: (input: CreateOpportunityInput) => Promise<CreatedRecord>;
  searchRecords: (input: SearchRecordsInput) => Promise<CreatedRecord[]>;
  getRecord: (input: GetRecordInput) => Promise<CreatedRecord>;
  updateRecord: (input: UpdateRecordInput) => Promise<CreatedRecord>;
};

function withDefinedStrings(
  fields: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const properties: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      properties[key] = value;
    }
  }

  return properties;
}

export function personProperties(
  input: CreatePersonInput,
): Record<string, string | number> {
  return withDefinedStrings({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    jobTitle: input.jobTitle,
    companyId: input.companyId,
  });
}

export function companyProperties(
  input: CreateCompanyInput,
): Record<string, string | number> {
  return withDefinedStrings({
    name: input.name,
    domain: input.domain,
  });
}

export function opportunityProperties(
  input: CreateOpportunityInput,
): Record<string, string | number> {
  return withDefinedStrings({
    name: input.name,
    stage: input.stage,
    amount: input.amount,
    currencyCode:
      input.amount !== undefined ? (input.currencyCode ?? 'USD') : undefined,
    companyId: input.companyId,
    pointOfContactId: input.pointOfContactId,
    closeDate: input.closeDate,
  });
}
