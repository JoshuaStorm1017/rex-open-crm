import type {
  CreatedRecord,
  TwentyCrmClient,
} from '../twenty/twenty-crm-client';
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
    ...inPreviewAmountWarnings(slots),
    ...(await companyAmountWarnings(client, workspaceId, slots)),
  ];
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
