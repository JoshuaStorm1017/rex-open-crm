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
  },
  company: {
    name: ['name'],
    domain: ['domainName'],
    website: ['domainName'],
    linkedin: ['linkedinLink'],
    address: ['address'],
    city: ['address'],
    accountOwner: ['accountOwnerId'],
  },
  opportunity: {
    name: ['name'],
    stage: ['stage'],
    amount: ['amount'],
    closeDate: ['closeDate'],
    owner: ['ownerId'],
  },
};
