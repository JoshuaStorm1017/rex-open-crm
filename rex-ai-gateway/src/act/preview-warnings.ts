import type {
  CreatedRecord,
  TwentyCrmClient,
} from '../twenty/twenty-crm-client';
import { domainHostKey } from '../twenty/map-to-twenty-payload';
import { isSafeSearchQuery } from '../twenty/safe-search';
import type { ProposalWarning } from './types';
import type { ValidatedTool } from './validate-tool';

type ReadySlot = { type: 'ready'; tool: ValidatedTool; record?: CreatedRecord };
type PreviewSlot = ReadySlot | { type: 'choice' };

export async function collectWarnings(
  client: TwentyCrmClient,
  workspaceId: string,
  slots: PreviewSlot[],
): Promise<ProposalWarning[]> {
  return [
    ...(await duplicateEmailWarnings(client, workspaceId, slots)),
    ...(await duplicateNameWarnings(client, workspaceId, slots)),
    ...(await duplicateDomainWarnings(client, workspaceId, slots)),
    ...inPreviewAmountWarnings(slots),
    ...(await companyAmountWarnings(client, workspaceId, slots)),
  ];
}

async function duplicateDomainWarnings(
  client: TwentyCrmClient,
  workspaceId: string,
  slots: PreviewSlot[],
): Promise<ProposalWarning[]> {
  const warnings: ProposalWarning[] = [];
  const seen = new Set<string>();

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    const target = domainTarget(slot);

    if (!target) {
      continue;
    }

    const key = domainHostKey(target.domain);

    if (seen.has(key)) {
      continue;
    }

    // A host the filter cannot quote must not abort the preview.
    if (!isSafeSearchQuery(key)) {
      continue;
    }

    // The name search cannot see a domain that is not in the company name.
    const matches = await client.searchRecords({
      workspaceId,
      objectName: 'company',
      query: key,
      domainHost: key,
      limit: 10,
    });
    const duplicate = matches.find((record) => {
      if (record.id === target.selfId) {
        return false;
      }

      const domain = record.properties.domain;
      const website = record.properties.website;

      return (
        (typeof domain === 'string' && domainHostKey(domain) === key) ||
        (typeof website === 'string' && domainHostKey(website) === key)
      );
    });

    if (!duplicate) {
      continue;
    }

    seen.add(key);
    const link = companyLinkOffer(slots, key, duplicate);
    warnings.push({
      code: 'duplicate_domain',
      message: `Another company already uses ${target.domain} (${duplicate.label}). This preview still proposes that domain.`,
      ...(link ? { link } : {}),
    });
  }

  return warnings;
}

function companyLinkOffer(
  slots: PreviewSlot[],
  host: string,
  duplicate: CreatedRecord,
): { companyId: string; label: string } | undefined {
  const removed = new Set<number>();

  slots.forEach((slot, index) => {
    if (slot.type !== 'ready' || slot.tool.name !== 'create_company') {
      return;
    }

    if (
      slot.tool.input.domain &&
      domainHostKey(slot.tool.input.domain) === host
    ) {
      removed.add(index);
    }
  });

  if (removed.size === 0) {
    return undefined;
  }

  let person = false;

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    for (const [key, value] of Object.entries(
      slot.tool.input as Record<string, unknown>,
    )) {
      if (typeof value !== 'string' || !/^\$\d+$/.test(value)) {
        continue;
      }

      if (!removed.has(Number(value.slice(1)))) {
        continue;
      }

      if (key !== 'companyId') {
        return undefined;
      }
    }

    if (slot.tool.name !== 'create_person') {
      continue;
    }

    const companyId = slot.tool.input.companyId;

    // An unlinked person is not "the new person" for this company.
    if (
      companyId &&
      /^\$\d+$/.test(companyId) &&
      removed.has(Number(companyId.slice(1)))
    ) {
      person = true;
    }
  }

  if (!person) {
    return undefined;
  }

  return { companyId: duplicate.id, label: duplicate.label };
}

function domainTarget(
  slot: ReadySlot,
): { domain: string; selfId?: string } | undefined {
  if (slot.tool.name === 'create_company' && slot.tool.input.domain) {
    return { domain: slot.tool.input.domain };
  }

  if (
    slot.tool.name === 'update_record' &&
    slot.tool.input.objectName === 'company' &&
    (slot.tool.input.field === 'domain' || slot.tool.input.field === 'website')
  ) {
    return {
      domain: String(slot.tool.input.value),
      selfId: slot.tool.input.id,
    };
  }

  return undefined;
}

async function duplicateEmailWarnings(
  client: TwentyCrmClient,
  workspaceId: string,
  slots: PreviewSlot[],
): Promise<ProposalWarning[]> {
  const warnings: ProposalWarning[] = [];

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    const email = emailOn(slot.tool);

    if (!email) {
      continue;
    }

    const selfId =
      slot.tool.name === 'update_record' ? slot.tool.input.id : undefined;
    const matches = await client.searchRecords({
      workspaceId,
      objectName: 'person',
      query: email,
      limit: 10,
    });
    const duplicate = matches.find(
      (record) =>
        record.id !== selfId &&
        typeof record.properties.email === 'string' &&
        record.properties.email.toLowerCase() === email.toLowerCase(),
    );

    if (!duplicate) {
      continue;
    }

    warnings.push({
      code: 'duplicate_email',
      message: `Another person already uses ${email} (${duplicate.label}). This preview still proposes that email.`,
    });
  }

  return warnings;
}

async function duplicateNameWarnings(
  client: TwentyCrmClient,
  workspaceId: string,
  slots: PreviewSlot[],
): Promise<ProposalWarning[]> {
  const warnings: ProposalWarning[] = [];
  const seen = new Set<string>();

  for (const target of nameTargets(slots)) {
    const companies = await companyIdsFor(client, workspaceId, slots, target);

    for (const company of companies) {
      const key = `${target.firstName.toLowerCase()} ${target.lastName.toLowerCase()}@${company.id}`;

      if (seen.has(key)) {
        continue;
      }

      const matches = await client.searchRecords({
        workspaceId,
        objectName: 'person',
        query: `${target.firstName} ${target.lastName}`,
        limit: 10,
        linkedCompanyId: company.id,
      });
      const duplicate = matches.find(
        (record) =>
          record.id !== target.selfId &&
          record.properties.companyId === company.id &&
          sameName(record, target.firstName, target.lastName),
      );

      if (!duplicate) {
        continue;
      }

      seen.add(key);
      warnings.push({
        code: 'duplicate_name',
        message: `Another person named ${target.firstName} ${target.lastName} is already linked to ${company.label}. This preview still proposes that name.`,
      });
    }
  }

  return warnings;
}

function nameTargets(slots: PreviewSlot[]): Array<{
  firstName: string;
  lastName: string;
  companyId?: string;
  companyName?: string;
  selfId?: string;
}> {
  const targets: Array<{
    firstName: string;
    lastName: string;
    companyId?: string;
    companyName?: string;
    selfId?: string;
  }> = [];

  for (const slot of slots) {
    if (slot.type !== 'ready' || slot.tool.name !== 'create_person') {
      continue;
    }

    const companyId = slot.tool.input.companyId;

    targets.push({
      firstName: slot.tool.input.firstName,
      lastName: slot.tool.input.lastName,
      ...(companyId?.startsWith('$')
        ? { companyName: companyNameAt(slots, companyId) }
        : companyId
          ? { companyId }
          : {}),
    });
  }

  const people = new Map<
    string,
    {
      firstName?: string;
      lastName?: string;
      companyId?: string;
      nameChanged: boolean;
    }
  >();

  for (const slot of slots) {
    if (
      slot.type !== 'ready' ||
      slot.tool.name !== 'update_record' ||
      slot.tool.input.objectName !== 'person' ||
      !slot.tool.input.id ||
      !slot.record
    ) {
      continue;
    }

    const current = people.get(slot.tool.input.id) ?? {
      firstName: stringProp(slot.record, 'firstName'),
      lastName: stringProp(slot.record, 'lastName'),
      companyId: stringProp(slot.record, 'companyId'),
      nameChanged: false,
    };

    if (slot.tool.input.field === 'firstName') {
      current.firstName = String(slot.tool.input.value);
      current.nameChanged = true;
    }

    if (slot.tool.input.field === 'lastName') {
      current.lastName = String(slot.tool.input.value);
      current.nameChanged = true;
    }

    people.set(slot.tool.input.id, current);
  }

  for (const [id, person] of people) {
    if (
      !person.nameChanged ||
      !person.firstName ||
      !person.lastName ||
      !person.companyId
    ) {
      continue;
    }

    targets.push({
      firstName: person.firstName,
      lastName: person.lastName,
      companyId: person.companyId,
      selfId: id,
    });
  }

  return targets;
}

function companyNameAt(slots: PreviewSlot[], ref: string): string | undefined {
  const index = Number(ref.slice(1));
  const slot = slots[index];

  if (!slot || slot.type !== 'ready' || slot.tool.name !== 'create_company') {
    return undefined;
  }

  return slot.tool.input.name;
}

async function companyIdsFor(
  client: TwentyCrmClient,
  workspaceId: string,
  _slots: PreviewSlot[],
  target: { companyId?: string; companyName?: string },
): Promise<Array<{ id: string; label: string }>> {
  if (target.companyId) {
    try {
      const company = await client.getRecord({
        workspaceId,
        objectName: 'company',
        id: target.companyId,
      });

      return [{ id: company.id, label: company.label }];
    } catch {
      return [{ id: target.companyId, label: target.companyId }];
    }
  }

  if (!target.companyName) {
    return [];
  }

  const matches = await client.searchRecords({
    workspaceId,
    objectName: 'company',
    query: target.companyName,
    limit: 8,
  });

  return matches
    .filter((company) => {
      const name = company.properties.name;

      return (
        company.label.toLowerCase() === target.companyName?.toLowerCase() ||
        (typeof name === 'string' &&
          name.toLowerCase() === target.companyName?.toLowerCase())
      );
    })
    .map((company) => ({ id: company.id, label: company.label }));
}

function sameName(
  record: CreatedRecord,
  firstName: string,
  lastName: string,
): boolean {
  return (
    stringProp(record, 'firstName')?.toLowerCase() ===
      firstName.toLowerCase() &&
    stringProp(record, 'lastName')?.toLowerCase() === lastName.toLowerCase()
  );
}

function stringProp(record: CreatedRecord, field: string): string | undefined {
  const value = record.properties[field];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function inPreviewAmountWarnings(slots: PreviewSlot[]): ProposalWarning[] {
  const warnings: ProposalWarning[] = [];
  const created: Array<{ companyKey: string; amount: number; name: string }> =
    [];

  for (const slot of slots) {
    if (
      slot.type !== 'ready' ||
      slot.tool.name !== 'create_opportunity' ||
      slot.tool.input.amount === undefined
    ) {
      continue;
    }

    const companyKey = slot.tool.input.companyId;
    const amount = slot.tool.input.amount;
    const name = slot.tool.input.name;

    if (!companyKey) {
      continue;
    }

    const prior = created.find(
      (item) => item.companyKey === companyKey && item.amount !== amount,
    );

    if (prior) {
      warnings.push({
        code: 'amount_mismatch',
        message: `This amount (${formatMoney(amount)}) does not match “${prior.name}” (${formatMoney(prior.amount)}) in this preview. This preview still proposes ${formatMoney(amount)}.`,
      });
    }

    created.push({ companyKey, amount, name });
  }

  return warnings;
}

async function companyAmountWarnings(
  client: TwentyCrmClient,
  workspaceId: string,
  slots: PreviewSlot[],
): Promise<ProposalWarning[]> {
  const warnings: ProposalWarning[] = [];

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    const target = amountTarget(slot);

    if (!target || target.companyId.startsWith('$')) {
      continue;
    }

    const matches = await client.searchRecords({
      workspaceId,
      objectName: 'opportunity',
      query: target.companyId,
      limit: 20,
      linkedCompanyId: target.companyId,
    });
    const other = matches.find(
      (record) =>
        record.id !== target.selfId &&
        record.properties.companyId === target.companyId &&
        typeof record.properties.amount === 'number' &&
        record.properties.amount !== target.amount,
    );

    if (!other || typeof other.properties.amount !== 'number') {
      continue;
    }

    let companyLabel = target.companyId;

    try {
      const company = await client.getRecord({
        workspaceId,
        objectName: 'company',
        id: target.companyId,
      });
      companyLabel = company.label;
    } catch {
      companyLabel = target.companyId;
    }

    warnings.push({
      code: 'amount_mismatch',
      message: `This amount (${formatMoney(target.amount)}) does not match ${companyLabel}'s opportunity “${other.label}” (${formatMoney(other.properties.amount)}). This preview still proposes ${formatMoney(target.amount)}.`,
    });
  }

  return warnings;
}

function emailOn(tool: ValidatedTool): string | undefined {
  if (tool.name === 'create_person' && tool.input.email) {
    return tool.input.email;
  }

  if (
    tool.name === 'update_record' &&
    tool.input.objectName === 'person' &&
    tool.input.field === 'email'
  ) {
    return String(tool.input.value);
  }

  return undefined;
}

function amountTarget(
  slot: ReadySlot,
): { companyId: string; amount: number; selfId?: string } | undefined {
  if (
    slot.tool.name === 'create_opportunity' &&
    slot.tool.input.amount !== undefined &&
    slot.tool.input.companyId
  ) {
    return {
      companyId: slot.tool.input.companyId,
      amount: slot.tool.input.amount,
    };
  }

  if (
    slot.tool.name === 'update_record' &&
    slot.tool.input.objectName === 'opportunity' &&
    slot.tool.input.field === 'amount' &&
    typeof slot.tool.input.value === 'number'
  ) {
    const companyId = slot.record?.properties.companyId;

    if (typeof companyId !== 'string' || companyId.length === 0) {
      return undefined;
    }

    return {
      companyId,
      amount: slot.tool.input.value,
      selfId: slot.tool.input.id,
    };
  }

  return undefined;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}
