import type { UpdatableObjectName } from '../act/writable-fields';

// Gateway field names are not always Twenty's metadata names. A lock on the metadata field blocks the gateway field.
export const FIELD_METADATA_NAMES: Record<UpdatableObjectName, Record<string, readonly string[]>> = {
  person: {
    firstName: ['name'],
    lastName: ['name'],
    email: ['emails'],
    jobTitle: ['jobTitle'],
    phone: ['phones'],
    linkedin: ['linkedinLink'],
    companyId: ['company'],
  },
  company: {
    name: ['name'],
    domain: ['domainName'],
    website: ['domainName'],
    linkedin: ['linkedinLink'],
    address: ['address'],
    city: ['address'],
    accountOwner: ['accountOwner'],
  },
  opportunity: {
    name: ['name'],
    stage: ['stage'],
    amount: ['amount'],
    closeDate: ['closeDate'],
    owner: ['owner'],
    companyId: ['company'],
    pointOfContactId: ['pointOfContact'],
  },
};

// Relation ids are create-only. update_record does not accept them, so they stay out of UPDATABLE_FIELDS.
export const CREATE_RELATION_FIELD_NAMES = {
  person: ['companyId'],
  company: [],
  opportunity: ['companyId', 'pointOfContactId'],
} as const satisfies Record<UpdatableObjectName, readonly string[]>;
