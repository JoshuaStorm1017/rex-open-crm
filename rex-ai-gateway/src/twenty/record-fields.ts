import { isRecord } from '../is-record';
import type {
  AddressFields,
  CreatedRecord,
  RecordComposites,
  TwentyObjectName,
} from './twenty-crm-client';

export function labelFromProperties(
  objectName: CreatedRecord['objectName'],
  properties: Record<string, string | number>,
): string {
  if (objectName === 'person') {
    const name = [properties.firstName, properties.lastName]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');

    if (name.length > 0) {
      return name;
    }

    if (typeof properties.email === 'string') {
      return properties.email;
    }
  }

  if (typeof properties.title === 'string' && properties.title.length > 0) {
    return properties.title;
  }

  if (typeof properties.name === 'string' && properties.name.length > 0) {
    return properties.name;
  }

  return objectName;
}

export function activityRecordFromTwenty(
  objectName: 'note' | 'task' | 'timelineActivity',
  workspaceId: string,
  raw: unknown,
): CreatedRecord | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
    return undefined;
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = readMarkdown(raw.bodyV2).replace(/\s+/g, ' ').trim().slice(0, 240);
  const linkedName = typeof raw.linkedRecordCachedName === 'string' ? raw.linkedRecordCachedName.trim() : '';
  const label = title || linkedName || body || raw.id;
  const properties: Record<string, string | number> = {};

  if (title) {
    properties.title = title;
  }

  if (body) {
    properties.body = body;
  }

  if (linkedName) {
    properties.name = linkedName;
  }

  return {
    id: raw.id,
    objectName,
    workspaceId,
    properties,
    etag: readEtag(raw),
    label,
  };
}

function readMarkdown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (isRecord(value) && typeof value.markdown === 'string') {
    return value.markdown;
  }

  return '';
}

export function readEtag(value: unknown): string {
  if (isRecord(value) && typeof value.updatedAt === 'string' && value.updatedAt.trim()) {
    return value.updatedAt.trim();
  }

  return 'unversioned';
}

export function nextVersionEtag(etag: string): string {
  const match = /^v(\d+)$/.exec(etag);

  if (!match?.[1]) {
    return etag;
  }

  return `v${Number(match[1]) + 1}`;
}

export function cloneRecord(record: CreatedRecord): CreatedRecord {
  return {
    ...record,
    properties: { ...record.properties },
    ...(record.composites
      ? {
          composites: {
            ...record.composites,
            ...(record.composites.additionalEmails
              ? { additionalEmails: [...record.composites.additionalEmails] }
              : {}),
            ...(record.composites.secondaryLinks
              ? {
                  secondaryLinks: record.composites.secondaryLinks.map((link) => ({
                    ...link,
                  })),
                }
              : {}),
            ...(record.composites.linkedinSecondaryLinks
              ? {
                  linkedinSecondaryLinks: record.composites.linkedinSecondaryLinks.map((link) => ({
                    ...link,
                  })),
                }
              : {}),
            ...(record.composites.address ? { address: { ...record.composites.address } } : {}),
          },
        }
      : {}),
  };
}

export function projectField(
  properties: Record<string, string | number>,
  field: string,
  value: string | number | null,
): Record<string, string | number> {
  const next = { ...properties };

  if (value === null) {
    delete next[field];
  } else {
    next[field] = value;
  }

  // website and domain are the same Twenty link. Keep both names pointing at it.
  if (field === 'domain' || field === 'website') {
    if (value === null) {
      delete next.domain;
      delete next.website;
    } else {
      next.domain = value;
      next.website = value;
    }
  }

  return next;
}

export function applyField(
  record: CreatedRecord,
  field: string,
  value: string | number | null,
): void {
  record.properties = projectField(record.properties, field, value);
  record.label = labelFromProperties(record.objectName, record.properties);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const list = value.filter((item): item is string => typeof item === 'string');

  return list.length === value.length ? list : undefined;
}

function readLinkList(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const links: Array<Record<string, string>> = [];

  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }

    const link: Record<string, string> = {};

    for (const [key, entry] of Object.entries(item)) {
      if (typeof entry !== 'string') {
        return undefined;
      }

      link[key] = entry;
    }

    links.push(link);
  }

  return links;
}

function readAddress(raw: Record<string, unknown>): AddressFields | undefined {
  const source = isRecord(raw.address) ? raw.address : undefined;

  if (!source) {
    return undefined;
  }

  const address: AddressFields = {
    ...(readString(source.addressStreet1) ? { addressStreet1: readString(source.addressStreet1) } : {}),
    ...(readString(source.addressStreet2) ? { addressStreet2: readString(source.addressStreet2) } : {}),
    ...(readString(source.addressCity) ? { addressCity: readString(source.addressCity) } : {}),
    ...(readString(source.addressState) ? { addressState: readString(source.addressState) } : {}),
    ...(readString(source.addressPostcode) ? { addressPostcode: readString(source.addressPostcode) } : {}),
    ...(readString(source.addressCountry) ? { addressCountry: readString(source.addressCountry) } : {}),
  };

  return Object.keys(address).length > 0 ? address : undefined;
}

function readComposites(raw: Record<string, unknown>): RecordComposites | undefined {
  const emails = isRecord(raw.emails) ? raw.emails : undefined;
  const domainName = isRecord(raw.domainName) ? raw.domainName : undefined;
  const linkedin = isRecord(raw.linkedinLink) ? raw.linkedinLink : undefined;
  const additionalEmails = readStringList(emails?.additionalEmails);
  const secondaryLinks = readLinkList(domainName?.secondaryLinks);
  const primaryLinkLabel = readString(domainName?.primaryLinkLabel);
  const linkedinLabel = readString(linkedin?.primaryLinkLabel);
  const linkedinSecondaryLinks = readLinkList(linkedin?.secondaryLinks);
  const address = readAddress(raw);
  const composites: RecordComposites = {
    ...(additionalEmails ? { additionalEmails } : {}),
    ...(secondaryLinks ? { secondaryLinks } : {}),
    ...(primaryLinkLabel ? { primaryLinkLabel } : {}),
    ...(linkedinLabel ? { linkedinLabel } : {}),
    ...(linkedinSecondaryLinks ? { linkedinSecondaryLinks } : {}),
    ...(address ? { address } : {}),
  };

  return Object.keys(composites).length > 0 ? composites : undefined;
}

function readPersonProperties(raw: Record<string, unknown>): Record<string, string | number> {
  const properties: Record<string, string | number> = {};
  const name = isRecord(raw.name) ? raw.name : undefined;
  const firstName = readString(name?.firstName) ?? readString(raw.firstName);
  const lastName = readString(name?.lastName) ?? readString(raw.lastName);
  const emails = isRecord(raw.emails) ? raw.emails : undefined;
  const email = readString(emails?.primaryEmail) ?? readString(raw.email);
  const jobTitle = readString(raw.jobTitle);
  const companyId = readString(raw.companyId);
  const phones = isRecord(raw.phones) ? raw.phones : undefined;
  const phoneNumber = readString(phones?.primaryPhoneNumber);
  const callingCode = readString(phones?.primaryPhoneCallingCode);
  const phone = phoneNumber ? (callingCode ? `${callingCode} ${phoneNumber}` : phoneNumber) : readString(raw.phone);
  const linkedinLink = isRecord(raw.linkedinLink) ? raw.linkedinLink : undefined;
  const linkedin = readString(linkedinLink?.primaryLinkUrl) ?? readString(raw.linkedin);

  if (firstName) {
    properties.firstName = firstName;
  }

  if (lastName) {
    properties.lastName = lastName;
  }

  if (email) {
    properties.email = email;
  }

  if (jobTitle) {
    properties.jobTitle = jobTitle;
  }

  if (phone) {
    properties.phone = phone;
  }

  if (linkedin) {
    properties.linkedin = linkedin;
  }

  if (companyId) {
    properties.companyId = companyId;
  }

  return properties;
}

function readCompanyProperties(raw: Record<string, unknown>): Record<string, string | number> {
  const properties: Record<string, string | number> = {};
  const name = readString(raw.name);
  const domainName = isRecord(raw.domainName) ? raw.domainName : undefined;
  const domain =
    readString(domainName?.primaryLinkUrl) ??
    readString(raw.domain) ??
    readString(raw.website) ??
    readString(raw.domainName);
  const linkedinLink = isRecord(raw.linkedinLink) ? raw.linkedinLink : undefined;
  const linkedin = readString(linkedinLink?.primaryLinkUrl) ?? readString(raw.linkedin);
  const address = isRecord(raw.address) ? raw.address : undefined;
  const street = readString(address?.addressStreet1) ?? readString(raw.address);
  const city = readString(address?.addressCity) ?? readString(raw.city);
  const accountOwnerId = readString(raw.accountOwnerId) ?? readString(raw.accountOwner);

  if (name) {
    properties.name = name;
  }

  if (domain) {
    properties.domain = domain;
    properties.website = domain;
  }

  if (linkedin) {
    properties.linkedin = linkedin;
  }

  if (street) {
    properties.address = street;
  }

  if (city) {
    properties.city = city;
  }

  if (accountOwnerId) {
    properties.accountOwner = accountOwnerId;
  }

  return properties;
}

function readOpportunityProperties(
  raw: Record<string, unknown>,
): Record<string, string | number> {
  const properties: Record<string, string | number> = {};
  const name = readString(raw.name);
  const stage = readString(raw.stage);
  const amountRecord = isRecord(raw.amount) ? raw.amount : undefined;
  const currencyCode =
    readString(amountRecord?.currencyCode) ?? readString(raw.currencyCode);
  const companyId = readString(raw.companyId);
  const pointOfContactId = readString(raw.pointOfContactId);
  const closeDate = readString(raw.closeDate);
  const ownerId = readString(raw.ownerId) ?? readString(raw.owner);

  if (name) {
    properties.name = name;
  }

  if (stage) {
    properties.stage = stage;
  }

  if (typeof amountRecord?.amountMicros === 'number') {
    properties.amount = amountRecord.amountMicros / 1_000_000;
  } else if (typeof raw.amount === 'number') {
    properties.amount = raw.amount;
  }

  if (currencyCode && properties.amount !== undefined) {
    properties.currencyCode = currencyCode;
  }

  if (companyId) {
    properties.companyId = companyId;
  }

  if (pointOfContactId) {
    properties.pointOfContactId = pointOfContactId;
  }

  if (closeDate) {
    properties.closeDate = closeDate;
  }

  if (ownerId) {
    properties.owner = ownerId;
  }

  return properties;
}

export function crmRecordFromTwenty(
  objectName: TwentyObjectName,
  workspaceId: string,
  raw: unknown,
): CreatedRecord | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
    return undefined;
  }

  const properties =
    objectName === 'person'
      ? readPersonProperties(raw)
      : objectName === 'company'
        ? readCompanyProperties(raw)
        : readOpportunityProperties(raw);

  const composites = readComposites(raw);

  return {
    id: raw.id,
    objectName,
    workspaceId,
    properties,
    etag: readEtag(raw),
    label: labelFromProperties(objectName, properties) || raw.id,
    ...(composites ? { composites } : {}),
  };
}
