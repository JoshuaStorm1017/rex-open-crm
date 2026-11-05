import { mapIntentToTool } from '../act/map-intent';
import { refusal, type ActRefusal, type ToolCall } from '../act/types';
import type { TwentyObjectName } from '../twenty/twenty-crm-client';
import type { LlmPlan, LlmPlanInput, LlmProvider } from './llm-provider';

const UNSAFE_PATTERN =
  /^(?:delete|drop|destroy|wipe|remove|truncate|export|dump)\b|\b(?:password|api key|credential|access token)\b|\b(?:drop table|delete from)\b/i;

const COMPOUND_PATTERN =
  /^add (?<company>.+?) as a company and a \$(?<amount>[\d,]+(?:\.\d+)?)(?<multiplier>k)? deal for (?<firstName>\S+) (?<lastName>\S+)$/i;

const SEARCH_PATTERN =
  /^(?:find|search) (?<object>people|persons|person|companies|company|opportunities|opportunity|deals) (?:named|called|for|matching) (?<query>.+)$/i;

const UPDATE_BY_ID_PATTERN =
  /^update (?<object>person|company|opportunity) (?<id>[A-Za-z0-9_-]+) set (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+?)(?: ifMatch (?<ifMatch>\S+))?$/i;

const UPDATE_BY_NAME_PATTERN =
  /^update (?<object>person|company|opportunity) named (?<query>.+?) set (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+?)(?: ifMatch (?<ifMatch>\S+))?$/i;

const AMBIGUOUS_PATTERN = /^(?:update|change|edit|set|rename|modify)\b/i;

export function createMockLlmProvider(): LlmProvider {
  return {
    async plan(input) {
      return planDeterministic(input);
    },
  };
}

async function planDeterministic(input: LlmPlanInput): Promise<LlmPlan> {
  const text = input.intent.trim().replace(/\s+/g, ' ');

  if (text.length === 0) {
    return refusal('invalid_request', 'Provide a non-empty intent.');
  }

  if (UNSAFE_PATTERN.test(text)) {
    return refusal(
      'unsafe_intent',
      'Refusing this request. Deletes, exports, and credential access are not allowlisted.',
    );
  }

  const compound = COMPOUND_PATTERN.exec(text);

  if (compound?.groups?.company && compound.groups.firstName && compound.groups.lastName) {
    const amount = parseMoney(compound.groups.amount ?? '', compound.groups.multiplier);

    if (amount === undefined) {
      return refusal('invalid_request', 'The deal amount is not a number.', {
        toolName: 'create_opportunity',
      });
    }

    const company = compound.groups.company.trim();

    return {
      ok: true,
      summary: `Create ${company}, ${compound.groups.firstName} ${compound.groups.lastName}, and a ${formatUsd(amount)} opportunity.`,
      tools: [
        { name: 'create_company', args: { name: company } },
        {
          name: 'create_person',
          args: {
            firstName: compound.groups.firstName,
            lastName: compound.groups.lastName,
          },
        },
        {
          name: 'create_opportunity',
          args: {
            name: `${company} deal`,
            amount,
            companyId: '$0',
            pointOfContactId: '$1',
          },
        },
      ],
    };
  }

  const search = SEARCH_PATTERN.exec(text);

  if (search?.groups?.object && search.groups.query) {
    return {
      ok: true,
      summary: `Search ${search.groups.object} for ${search.groups.query.trim()}.`,
      tools: [
        {
          name: 'search_records',
          args: {
            object: objectNameFor(search.groups.object),
            query: trimValue(search.groups.query),
          },
        },
      ],
    };
  }

  const updateById = UPDATE_BY_ID_PATTERN.exec(text);

  if (updateById?.groups?.object && updateById.groups.id && updateById.groups.field && updateById.groups.value) {
    return {
      ok: true,
      summary: `Update ${updateById.groups.object} ${updateById.groups.id}.`,
      tools: [updateTool(updateById.groups)],
    };
  }

  const updateByName = UPDATE_BY_NAME_PATTERN.exec(text);

  if (
    updateByName?.groups?.object &&
    updateByName.groups.query &&
    updateByName.groups.field &&
    updateByName.groups.value
  ) {
    return resolveNamedUpdate(input, updateByName.groups);
  }

  const mapped = mapIntentToTool(text);

  if (!('refused' in mapped)) {
    return {
      ok: true,
      summary: `Run ${mapped.name}.`,
      tools: [mapped],
    };
  }

  if (AMBIGUOUS_PATTERN.test(text)) {
    return refusal(
      'ambiguous_intent',
      'This update does not name one record. Use "update company <id> set <field> to <value>" or "update company named <name> set <field> to <value>".',
    );
  }

  if (mapped.reason === 'unmapped_intent' && !/^create\b/i.test(text)) {
    return refusal(
      'unmapped_intent',
      'No allowlisted action matches this request. Try "add <name> as a company and a $<amount>k deal for <first> <last>", "find companies named <name>", or "update company <id> set domain to <domain>".',
    );
  }

  return mapped;
}

async function resolveNamedUpdate(
  input: LlmPlanInput,
  groups: Record<string, string>,
): Promise<LlmPlan> {
  const objectName = objectNameFor(groups.object ?? '');
  const query = trimValue(groups.query ?? '');
  const matches = await input.client.searchRecords({
    workspaceId: input.workspaceId,
    objectName,
    query,
    limit: 10,
  });

  if (matches.length === 0) {
    return refusal('not_found', `No ${objectName} matches “${query}”.`, {
      toolName: 'update_record',
    });
  }

  if (matches.length > 1) {
    const names = matches.map((record) => record.label).join(', ');

    return refusal(
      'ambiguous_intent',
      `Several ${objectName} records match “${query}”: ${names}. Name one record id.`,
      { toolName: 'update_record' },
    );
  }

  const match = matches[0];

  if (!match) {
    return refusal('not_found', `No ${objectName} matches “${query}”.`, {
      toolName: 'update_record',
    });
  }

  return {
    ok: true,
    summary: `Update ${objectName} ${match.label}.`,
    tools: [
      updateTool({
        ...groups,
        id: match.id,
      }),
    ],
  };
}

function updateTool(groups: Record<string, string | undefined>): ToolCall {
  const field = groups.field ?? '';
  const args: Record<string, unknown> = {
    object: objectNameFor(groups.object ?? ''),
    id: groups.id,
    field,
    value: field === 'amount' ? Number((groups.value ?? '').replace(/,/g, '')) : trimValue(groups.value ?? ''),
  };

  if (groups.ifMatch) {
    args.ifMatch = groups.ifMatch;
  }

  return { name: 'update_record', args };
}

function objectNameFor(word: string): TwentyObjectName {
  const normalized = word.toLowerCase();

  if (normalized === 'person' || normalized === 'people' || normalized === 'persons') {
    return 'person';
  }

  if (normalized === 'opportunity' || normalized === 'opportunities' || normalized === 'deals') {
    return 'opportunity';
  }

  return 'company';
}

function parseMoney(amount: string, multiplier: string | undefined): number | undefined {
  const numeric = Number(amount.replace(/,/g, ''));

  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }

  return multiplier ? numeric * 1000 : numeric;
}

function trimValue(value: string): string {
  return value.trim().replace(/[.]+$/, '');
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}

export function isActRefusal(value: LlmPlan): value is ActRefusal {
  return value.ok === false;
}
