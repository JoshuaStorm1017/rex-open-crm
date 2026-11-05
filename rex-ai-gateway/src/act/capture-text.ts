import { canonicalLinkedinUrl } from '../twenty/linkedin-url';
import { parsePhone } from '../twenty/parse-phone';
import { canCreateObject, canSetField, type AudienceLoad } from './permissions';
import { refusal, type ActRefusal, type ToolCall } from './types';

export type CaptureInput = {
  source: 'card' | 'voice';
  text: string;
};

type CaptureFields = {
  firstName?: string;
  lastName?: string;
  email?: string;
  jobTitle?: string;
  phone?: string;
  linkedin?: string;
  company?: string;
  domain?: string;
  address?: string;
  city?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABELED_LINE =
  /^(name|person|title|job|company|email|phone|linkedin|domain|website|address|city)\s*:\s*(.+)$/i;

export function captureToTools(
  capture: CaptureInput,
  audience: AudienceLoad,
): ToolCall[] | ActRefusal {
  const fields =
    capture.source === 'voice'
      ? (parseVoice(capture.text) ??
        parseLabeled(capture.text) ??
        parseVCard(capture.text))
      : (parseVCard(capture.text) ??
        parseLabeled(capture.text) ??
        parsePlainCard(capture.text) ??
        parseVoice(capture.text));

  if (!fields) {
    return refusal(
      'missing_required_fields',
      'The card or dictation needs a person name or a company name.',
      { missingFields: ['firstName', 'lastName'] },
    );
  }

  fillDomainFromEmail(fields);

  return toolsFromFields(fields, audience);
}

function toolsFromFields(
  fields: CaptureFields,
  audience: AudienceLoad,
): ToolCall[] | ActRefusal {
  const tools: ToolCall[] = [];
  const company = writableCompany(fields, audience);

  if (company) {
    tools.push({ name: 'create_company', args: company });
  }

  const person = writablePerson(fields, audience, company ? '$0' : undefined);

  if (person.kind === 'refused') {
    if (tools.length > 0) {
      return tools;
    }

    return person.refusal;
  }

  if (person.kind === 'person') {
    tools.push({ name: 'create_person', args: person.args });
  }

  if (tools.length === 0) {
    if (fields.firstName && !canCreateObject(audience, 'person')) {
      return refusal('forbidden', 'You cannot create person records.', {
        toolName: 'create_person',
      });
    }

    if (fields.company && !canCreateObject(audience, 'company')) {
      return refusal('forbidden', 'You cannot create company records.', {
        toolName: 'create_company',
      });
    }

    return refusal(
      'missing_required_fields',
      'The card or dictation needs a person name or a company name.',
      { missingFields: ['firstName', 'lastName'] },
    );
  }

  return tools;
}

function writableCompany(
  fields: CaptureFields,
  audience: AudienceLoad,
): Record<string, string> | undefined {
  if (
    !fields.company ||
    !canCreateObject(audience, 'company') ||
    !canSetField(audience, 'company', 'name')
  ) {
    return undefined;
  }

  const args: Record<string, string> = { name: fields.company };
  copyField(args, audience, 'company', 'domain', fields.domain);
  copyField(args, audience, 'company', 'address', fields.address);
  copyField(args, audience, 'company', 'city', fields.city);

  return args;
}

function writablePerson(
  fields: CaptureFields,
  audience: AudienceLoad,
  companyId: string | undefined,
):
  | { kind: 'skip' }
  | { kind: 'person'; args: Record<string, string> }
  | { kind: 'refused'; refusal: ActRefusal } {
  if (!fields.firstName || !fields.lastName) {
    return { kind: 'skip' };
  }

  if (!canCreateObject(audience, 'person')) {
    return {
      kind: 'refused',
      refusal: refusal('forbidden', 'You cannot create person records.', {
        toolName: 'create_person',
      }),
    };
  }

  if (
    !canSetField(audience, 'person', 'firstName') ||
    !canSetField(audience, 'person', 'lastName')
  ) {
    return {
      kind: 'refused',
      refusal: refusal('forbidden', 'You cannot set the person name.', {
        toolName: 'create_person',
      }),
    };
  }

  const args: Record<string, string> = {
    firstName: fields.firstName,
    lastName: fields.lastName,
  };
  copyField(args, audience, 'person', 'email', fields.email);
  copyField(args, audience, 'person', 'jobTitle', fields.jobTitle);
  copyField(args, audience, 'person', 'phone', fields.phone);
  copyField(args, audience, 'person', 'linkedin', fields.linkedin);

  if (companyId && canSetField(audience, 'person', 'companyId')) {
    args.companyId = companyId;
  }

  return { kind: 'person', args };
}

function copyField(
  args: Record<string, string>,
  audience: AudienceLoad,
  objectName: 'person' | 'company',
  field: string,
  value: string | undefined,
): void {
  if (value && canSetField(audience, objectName, field)) {
    args[field] = value;
  }
}

function parseVCard(text: string): CaptureFields | undefined {
  if (!/^BEGIN:VCARD/im.test(text)) {
    return undefined;
  }

  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const fields: CaptureFields = {};

  for (const line of unfolded.split('\n')) {
    const splitAt = line.indexOf(':');

    if (splitAt <= 0) {
      continue;
    }

    const key = line.slice(0, splitAt).split(';')[0]?.trim().toUpperCase();
    const value = clean(line.slice(splitAt + 1));

    if (!key || !value) {
      continue;
    }

    if (key === 'N') {
      const [lastName, firstName] = value.split(';');
      fields.firstName = clean(firstName);
      fields.lastName = clean(lastName);
    } else if (key === 'FN' && !fields.firstName) {
      assignName(fields, value);
    } else if (key === 'ORG' && !fields.company) {
      fields.company = clean(value.split(';')[0]);
    } else if (key === 'TITLE') {
      fields.jobTitle = value;
    } else if (key === 'EMAIL' && !fields.email) {
      fields.email = emailOrUndefined(value);
    } else if (key === 'TEL' && !fields.phone) {
      fields.phone = phoneOrUndefined(value);
    } else if (key === 'URL' && !fields.linkedin) {
      fields.linkedin = linkedinOrUndefined(value);
    } else if (key === 'ADR') {
      const parts = value.split(';');
      fields.address = fields.address ?? clean(parts[2]);
      fields.city = fields.city ?? clean(parts[3]);
    }
  }

  return hasIdentity(fields) ? fields : undefined;
}

function parseLabeled(text: string): CaptureFields | undefined {
  const fields: CaptureFields = {};
  let found = false;

  for (const line of text.split(/\n/)) {
    const match = LABELED_LINE.exec(line.trim());

    if (!match?.[1] || !match[2]) {
      continue;
    }

    found = true;
    assignLabel(fields, match[1], match[2]);
  }

  return found && hasIdentity(fields) ? fields : undefined;
}

function parseVoice(text: string): CaptureFields | undefined {
  const labeled = text
    .replace(/\s+at\s+/gi, '\ncompany ')
    .replace(
      /\b(person|name|job|title|email|phone|linkedin|domain|website|address|city|company)\b(?!\s*:)\s*/gi,
      (_match, key: string) => `\n${key}: `,
    );

  return parseLabeled(labeled);
}

function fillDomainFromEmail(fields: CaptureFields): void {
  if (fields.domain || !fields.email) {
    return;
  }

  const host = fields.email.split('@')[1];

  if (host && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) {
    fields.domain = host.toLowerCase();
  }
}

function parsePlainCard(text: string): CaptureFields | undefined {
  const fields: CaptureFields = {};
  const rest: string[] = [];

  for (const line of text
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (takeContactLine(fields, line)) {
      continue;
    }

    rest.push(line);
  }

  const nameIndex = rest.findIndex((line) =>
    /^[\p{L}][\p{L}'.-]*\s+[\p{L}][\p{L}'.-]*$/u.test(line),
  );

  if (nameIndex >= 0) {
    assignName(fields, rest[nameIndex] ?? '');
    rest.splice(nameIndex, 1);
  }

  const addressIndex = rest.findIndex((line) => /^\d+\s+\S/.test(line));

  if (addressIndex >= 0) {
    fields.address = clean(rest[addressIndex]);
    rest.splice(addressIndex, 1);
  }

  const companyIndex = rest.findIndex((line) =>
    /\b(Inc|Corp|Ltd|LLC|Engines|Company)\b/i.test(line),
  );

  if (companyIndex >= 0) {
    fields.company = clean(rest[companyIndex]);
    rest.splice(companyIndex, 1);
  }

  const singles = rest.filter((line) => !line.includes(' '));
  const longer = rest.filter((line) => line.includes(' '));

  if (!fields.company && longer[0]) {
    fields.company = clean(longer[0]);
  }

  if (singles.length >= 2) {
    fields.jobTitle = clean(singles[0]);
    fields.city = clean(singles[singles.length - 1]);
  } else if (singles.length === 1) {
    fields.city = clean(singles[0]);
  }

  return hasIdentity(fields) ? fields : undefined;
}

function takeContactLine(fields: CaptureFields, line: string): boolean {
  const email = line.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0];

  if (email && line.replace(email, '').trim() === '') {
    fields.email = emailOrUndefined(email);
    return true;
  }

  if (parsePhone(line)) {
    fields.phone = phoneOrUndefined(line);
    return true;
  }

  if (/linkedin\.com/i.test(line)) {
    fields.linkedin = linkedinOrUndefined(line);
    return Boolean(fields.linkedin);
  }

  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(line)) {
    fields.domain = clean(line)?.toLowerCase();
    return true;
  }

  return false;
}

function assignLabel(fields: CaptureFields, label: string, raw: string): void {
  const value = clean(raw);
  const key = label.toLowerCase();

  if (!value) {
    return;
  }

  if (key === 'name' || key === 'person') {
    assignName(fields, value);
  } else if (key === 'title' || key === 'job') {
    fields.jobTitle = value;
  } else if (key === 'company') {
    fields.company = value;
  } else if (key === 'email') {
    fields.email = emailOrUndefined(value);
  } else if (key === 'phone') {
    fields.phone = phoneOrUndefined(value);
  } else if (key === 'linkedin') {
    fields.linkedin = linkedinOrUndefined(value);
  } else if (key === 'domain' || key === 'website') {
    fields.domain = value.toLowerCase();
  } else if (key === 'address') {
    fields.address = value;
  } else if (key === 'city') {
    fields.city = value;
  }
}

function assignName(fields: CaptureFields, value: string): void {
  const parts = value.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return;
  }

  fields.firstName = clean(parts[0]);
  fields.lastName = clean(parts.slice(1).join(' '));
}

function hasIdentity(fields: CaptureFields): boolean {
  return Boolean((fields.firstName && fields.lastName) || fields.company);
}

function emailOrUndefined(value: string): string | undefined {
  const email = value.trim().toLowerCase();

  return EMAIL_PATTERN.test(email) ? email : undefined;
}

function phoneOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();

  return parsePhone(trimmed) ? trimmed : undefined;
}

function linkedinOrUndefined(value: string): string | undefined {
  return canonicalLinkedinUrl(value.trim());
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ').slice(0, 200);

  return trimmed ? trimmed : undefined;
}
