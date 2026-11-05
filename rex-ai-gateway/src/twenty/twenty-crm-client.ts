export type CreatePersonInput = {
  workspaceId: string;
  firstName: string;
  lastName: string;
  email?: string;
  jobTitle?: string;
  phone?: string;
  linkedin?: string;
  companyId?: string;
};

export type CreateCompanyInput = {
  workspaceId: string;
  name: string;
  domain?: string;
  linkedin?: string;
  address?: string;
  city?: string;
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

export type CreateNoteInput = {
  workspaceId: string;
  title?: string;
  body: string;
  targetObject: 'person' | 'company' | 'opportunity';
  targetId?: string;
  targetQuery?: string;
};

export type TwentyObjectName = 'person' | 'company' | 'opportunity';

export type DeletableObjectName = TwentyObjectName | 'note' | 'noteTarget';

export type AddressFields = {
  addressStreet1?: string;
  addressStreet2?: string;
  addressCity?: string;
  addressState?: string;
  addressPostcode?: string;
  addressCountry?: string;
};

export type RecordComposites = {
  additionalEmails?: string[];
  primaryLinkLabel?: string;
  secondaryLinks?: Array<Record<string, string>>;
  linkedinLabel?: string;
  linkedinSecondaryLinks?: Array<Record<string, string>>;
  address?: AddressFields;
};

export type CreatedRecord = {
  id: string;
  objectName: TwentyObjectName | 'note';
  workspaceId: string;
  properties: Record<string, string | number>;
  etag: string;
  label: string;
  composites?: RecordComposites;
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

export type DeleteRecordInput = {
  workspaceId: string;
  objectName: DeletableObjectName;
  id: string;
};

export type ClearRecordFieldInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  id: string;
  field: string;
  ifMatch: string;
};

export type ListRecentInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  limit: number;
};

export type NoteLookupInput = {
  workspaceId: string;
  id: string;
};

export type ArchiveRecordInput = {
  workspaceId: string;
  objectName: TwentyObjectName;
  id: string;
  ifMatch: string;
};

export type ObjectCapabilityName = TwentyObjectName | 'note';

export type FieldCapability = {
  name: string;
  canUpdate: boolean;
  // The metadata id for this field could not be read, so the write is refused.
  unreadable?: boolean;
};

export type MemberCapabilities = {
  unavailable?: boolean;
  objects: Array<{
    objectName: ObjectCapabilityName;
    canRead: boolean;
    canUpdate: boolean;
    // Twenty has no create flag. Omit this and create follows canUpdate.
    canCreate?: boolean;
    canSoftDelete: boolean;
    // Omit on a mock that only models object permissions. 'unavailable' fails closed.
    fieldPermissions?: 'unavailable' | FieldCapability[];
  }>;
};

export type TwentyCrmClient = {
  createPerson: (input: CreatePersonInput) => Promise<CreatedRecord>;
  createCompany: (input: CreateCompanyInput) => Promise<CreatedRecord>;
  createOpportunity: (input: CreateOpportunityInput) => Promise<CreatedRecord>;
  createNote: (input: CreateNoteInput) => Promise<CreatedRecord>;
  searchRecords: (input: SearchRecordsInput) => Promise<CreatedRecord[]>;
  listRecent: (input: ListRecentInput) => Promise<CreatedRecord[]>;
  getRecord: (input: GetRecordInput) => Promise<CreatedRecord>;
  getNote: (input: NoteLookupInput) => Promise<CreatedRecord>;
  updateRecord: (input: UpdateRecordInput) => Promise<CreatedRecord>;
  clearRecordField: (input: ClearRecordFieldInput) => Promise<CreatedRecord>;
  archiveRecord: (input: ArchiveRecordInput) => Promise<CreatedRecord>;
  restoreRecord: (input: DeleteRecordInput) => Promise<void>;
  deleteRecord: (input: DeleteRecordInput) => Promise<void>;
  loadCapabilities?: () => Promise<MemberCapabilities>;
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
    phone: input.phone,
    linkedin: input.linkedin,
    companyId: input.companyId,
  });
}

export function companyProperties(
  input: CreateCompanyInput,
): Record<string, string | number> {
  const website = input.domain;

  return withDefinedStrings({
    name: input.name,
    domain: website,
    website,
    linkedin: input.linkedin,
    address: input.address,
    city: input.city,
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
