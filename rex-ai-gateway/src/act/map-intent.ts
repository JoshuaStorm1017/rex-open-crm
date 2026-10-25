import { refusal, type ActRefusal, type ToolCall } from './types';

const PERSON_PATTERN =
  /^create\s+person\s+(?<firstName>\S+)\s+(?<lastName>\S+)(?:\s+email\s+(?<email>\S+))?(?:\s+job\s+(?<jobTitle>.+))?$/i;

const COMPANY_PATTERN =
  /^create\s+company\s+(?<name>.+?)(?:\s+domain\s+(?<domain>\S+))?$/i;

const OPPORTUNITY_PATTERN =
  /^create\s+opportunity\s+(?<name>.+?)(?:\s+amount\s+(?<amount>\d+(?:\.\d+)?))?(?:\s+stage\s+(?<stage>\S+))?(?:\s+company\s+(?<companyId>\S+))?$/i;

export function mapIntentToTool(intent: string): ToolCall | ActRefusal {
  const text = intent.trim().replace(/\s+/g, ' ');

  if (text.length === 0) {
    return refusal(
      'invalid_request',
      'Provide a tools array or a non-empty intent.',
    );
  }

  if (/^create\s+person\b/i.test(text)) {
    return mapPerson(text);
  }

  if (/^create\s+company\b/i.test(text)) {
    return mapCompany(text);
  }

  if (/^create\s+opportunity\b/i.test(text)) {
    return mapOpportunity(text);
  }

  return refusal(
    'unmapped_intent',
    'No create tool matches this intent. Use "create person|company|opportunity ...", or pass a tools array.',
  );
}

function mapPerson(text: string): ToolCall | ActRefusal {
  const match = PERSON_PATTERN.exec(text);

  if (!match?.groups?.firstName || !match.groups.lastName) {
    const nameTokens = text
      .replace(/^create\s+person\s*/i, '')
      .split(' ')
      .filter((token) => token.length > 0);

    if (nameTokens.length < 2) {
      return refusal(
        'missing_required_fields',
        'Intent "create person" requires a first name and a last name.',
        { toolName: 'create_person', missingFields: ['firstName', 'lastName'] },
      );
    }

    return refusal(
      'unmapped_intent',
      'Could not map this person intent. Expected: create person <first> <last> [email <email>] [job <title>].',
      { toolName: 'create_person' },
    );
  }

  const args: Record<string, unknown> = {
    firstName: match.groups.firstName,
    lastName: match.groups.lastName,
  };

  if (match.groups.email) {
    args.email = match.groups.email;
  }

  if (match.groups.jobTitle?.trim()) {
    args.jobTitle = match.groups.jobTitle.trim();
  }

  return { name: 'create_person', args };
}

function mapCompany(text: string): ToolCall | ActRefusal {
  const match = COMPANY_PATTERN.exec(text);
  const name = match?.groups?.name?.trim();

  if (!name) {
    return refusal(
      'missing_required_fields',
      'Intent "create company" requires a name.',
      { toolName: 'create_company', missingFields: ['name'] },
    );
  }

  const args: Record<string, unknown> = { name };

  if (match?.groups?.domain) {
    args.domain = match.groups.domain;
  }

  return { name: 'create_company', args };
}

function mapOpportunity(text: string): ToolCall | ActRefusal {
  const match = OPPORTUNITY_PATTERN.exec(text);
  const name = match?.groups?.name?.trim();

  if (!name) {
    return refusal(
      'missing_required_fields',
      'Intent "create opportunity" requires a name.',
      { toolName: 'create_opportunity', missingFields: ['name'] },
    );
  }

  const args: Record<string, unknown> = { name };

  if (match?.groups?.amount) {
    args.amount = Number(match.groups.amount);
  }

  if (match?.groups?.stage) {
    args.stage = match.groups.stage;
  }

  if (match?.groups?.companyId) {
    args.companyId = match.groups.companyId;
  }

  return { name: 'create_opportunity', args };
}
