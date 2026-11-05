import { mapIntentToTool } from '../act/map-intent';
import { refusal, type ActRefusal, type ToolCall } from '../act/types';
import type { TwentyObjectName } from '../twenty/twenty-crm-client';
import type {
  LlmPlan,
  LlmPlanInput,
  LlmProvider,
  PartialToolCall,
} from './llm-provider';

const UNSAFE_PATTERN =
  /^(?:delete|drop|destroy|wipe|remove|truncate|export|dump)\b|\b(?:password|api key|credential|access token)\b|\b(?:drop table|delete from)\b/i;

const COMPOUND_PATTERN =
  /^add (?<company>.+?) as a company and a \$(?<amount>[\d,]+(?:\.\d+)?)(?<multiplier>k)? deal for (?<firstName>\S+) (?<lastName>\S+)$/i;

const NOTE_PATTERN =
  /^add (?:a )?note(?: titled (?<title>.+?))? to (?<object>person|company|opportunity) named (?<query>.+?): (?<body>.+)$/i;

const SEARCH_PATTERN =
  /^(?:find|search) (?<object>people|persons|person|companies|company|opportunities|opportunity|deals) (?:named|called|for|matching) (?<query>.+)$/i;

const OPEN_TIMELINE_PATTERN =
  /^(?:what happened(?: with this (?<object>deal|opportunity|person|company|record))?|show (?<kind>notes|tasks|activities) on this (?<object2>deal|opportunity|person|company|record))\??$/i;

const SEARCH_NOTES_PATTERN =
  /^(?:find|search) notes? (?:about|matching|for|containing) (?<query>.+)$/i;

const SEARCH_TASKS_PATTERN =
  /^(?:find|search) tasks? (?:about|matching|for|named|containing) (?<query>.+)$/i;

const SEARCH_ACTIVITIES_PATTERN =
  /^(?:find|search) activities (?:about|matching|for|on|linked to) (?<query>.+)$/i;

const BULK_UPDATE_PATTERN =
  /^update all (?<object>people|persons|person|companies|company|opportunities|opportunity|deals) named (?<query>.+?) set (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+)$/i;

const THIS_UPDATE_PATTERN =
  /^(?:update|set|change) this (?<object>deal|opportunity|person|company|record)(?:['’]s)? (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+)$/i;

const THIS_NOTE_PATTERN =
  /^add (?:a )?note(?: titled (?<title>[^:]+?))?(?: to this (?<object>deal|opportunity|person|company|record))?: (?<body>.+)$/i;

const TWO_NAMED_UPDATES_PATTERN =
  /^update (?<object1>person|company|opportunity) named (?<query1>.+?) set (?<field1>[A-Za-z][A-Za-z0-9]*) to (?<value1>.+?) and update (?<object2>person|company|opportunity) named (?<query2>.+?) set (?<field2>[A-Za-z][A-Za-z0-9]*) to (?<value2>.+)$/i;

const MULTI_FIELD_BY_NAME_PATTERN =
  /^update (?<object>person|company|opportunity) named (?<query>.+?) set (?<field1>[A-Za-z][A-Za-z0-9]*) to (?<value1>.+?) and (?<field2>[A-Za-z][A-Za-z0-9]*) to (?<value2>.+?)(?: ifMatch (?<ifMatch>\S+))?$/i;

const THIS_MULTI_UPDATE_PATTERN =
  /^(?:update|set|change) this (?<object>deal|opportunity|person|company|record)(?:['’]s)? (?<field1>[A-Za-z][A-Za-z0-9]*) to (?<value1>.+?) and (?<field2>[A-Za-z][A-Za-z0-9]*) to (?<value2>.+)$/i;

const UPDATE_BY_ID_PATTERN =
  /^update (?<object>person|company|opportunity) (?<id>[A-Za-z0-9_-]+) set (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+?)(?: ifMatch (?<ifMatch>\S+))?$/i;

const UPDATE_BY_NAME_PATTERN =
  /^update (?<object>person|company|opportunity) named (?<query>.+?) set (?<field>[A-Za-z][A-Za-z0-9]*) to (?<value>.+?)(?: ifMatch (?<ifMatch>\S+))?$/i;

const ARCHIVE_BY_NAME_PATTERN =
  /^archive (?<object>person|company|opportunity|deal) named (?<query>.+)$/i;

const ARCHIVE_THIS_PATTERN =
  /^archive this (?<object>deal|opportunity|person|company|record)$/i;

const AMBIGUOUS_PATTERN = /^(?:update|change|edit|set|rename|modify)\b/i;

export function createMockLlmProvider(): LlmProvider {
  return {
    async plan(input) {
      return planDeterministic(input);
    },
    async planStream(input, emit) {
      const planned = await planDeterministic(input);

      if (!planned.ok) {
        return planned;
      }

      const partials: PartialToolCall[] = [];

      for (const tool of planned.tools) {
        partials.push({ name: tool.name, args: {}, complete: false });
        emit(partials.map((item) => ({ ...item, args: { ...item.args } })));
        const current = partials[partials.length - 1];

        if (current) {
          current.args = tool.args;
          current.complete = true;
        }

        emit(partials.map((item) => ({ ...item, args: { ...item.args } })));
      }

      return planned;
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

  if (
    compound?.groups?.company &&
    compound.groups.firstName &&
    compound.groups.lastName
  ) {
    const amount = parseMoney(
      compound.groups.amount ?? '',
      compound.groups.multiplier,
    );

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

  const archiveThis = ARCHIVE_THIS_PATTERN.exec(text);

  if (archiveThis?.groups?.object) {
    return thisRecordArchive(input, archiveThis.groups.object);
  }

  const archiveNamed = ARCHIVE_BY_NAME_PATTERN.exec(text);

  if (archiveNamed?.groups?.object && archiveNamed.groups.query) {
    const objectName = objectNameFor(archiveNamed.groups.object);

    return {
      ok: true,
      summary: `Archive ${objectName} named ${trimValue(archiveNamed.groups.query)}.`,
      tools: [
        {
          name: 'archive_record',
          args: {
            object: objectName,
            query: trimValue(archiveNamed.groups.query),
          },
        },
      ],
    };
  }

  const thisMulti = THIS_MULTI_UPDATE_PATTERN.exec(text);

  if (
    thisMulti?.groups?.object &&
    thisMulti.groups.field1 &&
    thisMulti.groups.field2
  ) {
    return thisRecordFields(input, thisMulti.groups);
  }

  const thisUpdate = THIS_UPDATE_PATTERN.exec(text);

  if (
    thisUpdate?.groups?.object &&
    thisUpdate.groups.field &&
    thisUpdate.groups.value
  ) {
    return thisRecordUpdate(input, thisUpdate.groups);
  }

  const note = NOTE_PATTERN.exec(text);

  if (note?.groups?.object && note.groups.query && note.groups.body) {
    return {
      ok: true,
      summary: `Add a note to ${note.groups.object} ${trimValue(note.groups.query)}.`,
      tools: [
        {
          name: 'create_note',
          args: {
            ...(note.groups.title
              ? { title: trimValue(note.groups.title) }
              : {}),
            body: note.groups.body.trim(),
            targetObject: objectNameFor(note.groups.object),
            targetQuery: trimValue(note.groups.query),
          },
        },
      ],
    };
  }

  const thisNote = THIS_NOTE_PATTERN.exec(text);

  if (thisNote?.groups?.body && (thisNote.groups.object || input.openRecord)) {
    return thisRecordNote(input, thisNote.groups);
  }

  const bulk = BULK_UPDATE_PATTERN.exec(text);

  if (
    bulk?.groups?.object &&
    bulk.groups.query &&
    bulk.groups.field &&
    bulk.groups.value
  ) {
    const field = bulk.groups.field;

    return {
      ok: true,
      summary: `Update every ${bulk.groups.object} named ${trimValue(bulk.groups.query)}.`,
      tools: [
        {
          name: 'update_matching_records',
          args: {
            object: objectNameFor(bulk.groups.object),
            query: trimValue(bulk.groups.query),
            field,
            value: fieldValue(field, bulk.groups.value),
          },
        },
      ],
    };
  }

  const openTimeline = OPEN_TIMELINE_PATTERN.exec(text);

  if (openTimeline) {
    return openRecordTimeline(input, openTimeline.groups ?? {});
  }

  const noteSearch = SEARCH_NOTES_PATTERN.exec(text);

  if (noteSearch?.groups?.query) {
    return timelineSearch('search_notes', 'notes', noteSearch.groups.query);
  }

  const taskSearch = SEARCH_TASKS_PATTERN.exec(text);

  if (taskSearch?.groups?.query) {
    return timelineSearch('search_tasks', 'tasks', taskSearch.groups.query);
  }

  const activitySearch = SEARCH_ACTIVITIES_PATTERN.exec(text);

  if (activitySearch?.groups?.query) {
    return timelineSearch(
      'search_activities',
      'activities',
      activitySearch.groups.query,
    );
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

  const twoNamed = TWO_NAMED_UPDATES_PATTERN.exec(text);

  if (
    twoNamed?.groups?.object1 &&
    twoNamed.groups.object2 &&
    twoNamed.groups.query1 &&
    twoNamed.groups.query2
  ) {
    return {
      ok: true,
      summary: `Update ${twoNamed.groups.object1} named ${trimValue(twoNamed.groups.query1)} and ${twoNamed.groups.object2} named ${trimValue(twoNamed.groups.query2)}.`,
      tools: [
        updateTool({
          object: twoNamed.groups.object1,
          query: trimValue(twoNamed.groups.query1),
          field: twoNamed.groups.field1,
          value: twoNamed.groups.value1,
        }),
        updateTool({
          object: twoNamed.groups.object2,
          query: trimValue(twoNamed.groups.query2),
          field: twoNamed.groups.field2,
          value: twoNamed.groups.value2,
        }),
      ],
    };
  }

  const multiField = MULTI_FIELD_BY_NAME_PATTERN.exec(text);

  if (
    multiField?.groups?.object &&
    multiField.groups.query &&
    multiField.groups.field1 &&
    multiField.groups.field2
  ) {
    const query = trimValue(multiField.groups.query);

    return {
      ok: true,
      summary: `Update ${multiField.groups.object} named ${query}.`,
      tools: [
        updateTool({
          object: multiField.groups.object,
          query,
          field: multiField.groups.field1,
          value: multiField.groups.value1,
          ifMatch: multiField.groups.ifMatch,
        }),
        updateTool({
          object: multiField.groups.object,
          query,
          field: multiField.groups.field2,
          value: multiField.groups.value2,
          ifMatch: multiField.groups.ifMatch,
        }),
      ],
    };
  }

  const updateById = UPDATE_BY_ID_PATTERN.exec(text);

  if (
    updateById?.groups?.object &&
    updateById.groups.id &&
    updateById.groups.field &&
    updateById.groups.value
  ) {
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
    return {
      ok: true,
      summary: `Update ${updateByName.groups.object} named ${trimValue(updateByName.groups.query)}.`,
      tools: [
        updateTool({
          ...updateByName.groups,
          id: undefined,
          query: trimValue(updateByName.groups.query),
        }),
      ],
    };
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

function thisRecordArchive(input: LlmPlanInput, word: string): LlmPlan {
  const objectName = openObject(word, input.openRecord);

  if (typeof objectName !== 'string') {
    return objectName;
  }

  return {
    ok: true,
    summary: `Archive the open ${objectName}.`,
    tools: [
      {
        name: 'archive_record',
        args: { object: objectName, recordRef: 'open' },
      },
    ],
  };
}

function thisRecordFields(
  input: LlmPlanInput,
  groups: Record<string, string | undefined>,
): LlmPlan {
  const objectName = openObject(groups.object ?? '', input.openRecord);

  if (typeof objectName !== 'string') {
    return objectName;
  }

  return {
    ok: true,
    summary: `Update the open ${objectName}.`,
    tools: [groups.field1, groups.field2]
      .filter((field): field is string => Boolean(field))
      .map((field, index) => ({
        name: 'update_record',
        args: {
          object: objectName,
          field,
          value: fieldValue(field, index === 0 ? groups.value1 : groups.value2),
          recordRef: 'open',
        },
      })),
  };
}

function thisRecordUpdate(
  input: LlmPlanInput,
  groups: Record<string, string | undefined>,
): LlmPlan {
  const objectName = openObject(groups.object ?? '', input.openRecord);

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const field = groups.field ?? '';

  return {
    ok: true,
    summary: `Update the open ${objectName}.`,
    tools: [
      {
        name: 'update_record',
        args: {
          object: objectName,
          field,
          value:
            field === 'amount'
              ? Number((groups.value ?? '').replace(/,/g, ''))
              : trimValue(groups.value ?? ''),
          recordRef: 'open',
        },
      },
    ],
  };
}

function thisRecordNote(
  input: LlmPlanInput,
  groups: Record<string, string | undefined>,
): LlmPlan {
  const objectName = openObject(groups.object ?? 'record', input.openRecord);

  if (typeof objectName !== 'string') {
    return objectName;
  }

  return {
    ok: true,
    summary: `Add a note to the open ${objectName}.`,
    tools: [
      {
        name: 'create_note',
        args: {
          ...(groups.title ? { title: trimValue(groups.title) } : {}),
          body: (groups.body ?? '').trim(),
          targetObject: objectName,
          recordRef: 'open',
        },
      },
    ],
  };
}

function openObject(
  word: string,
  openRecord: LlmPlanInput['openRecord'],
): TwentyObjectName | ActRefusal {
  if (!openRecord) {
    return refusal(
      'ambiguous_intent',
      'Open the record first, then refer to it as "this deal", "this person", or "this company".',
    );
  }

  const normalized = word.toLowerCase();
  const expected =
    normalized === 'deal' || normalized === 'opportunity'
      ? 'opportunity'
      : normalized === 'record'
        ? openRecord.objectName
        : normalized === 'person'
          ? 'person'
          : normalized === 'company'
            ? 'company'
            : undefined;

  if (!expected || expected !== openRecord.objectName) {
    return refusal(
      'invalid_request',
      `The open record is a ${openRecord.objectName}. "${word}" does not match it.`,
    );
  }

  return openRecord.objectName;
}

function openRecordTimeline(
  input: LlmPlanInput,
  groups: Record<string, string | undefined>,
): LlmPlan {
  const objectName = openObject(
    groups.object ?? groups.object2 ?? 'record',
    input.openRecord,
  );

  if (typeof objectName !== 'string') {
    return objectName;
  }

  const kind = groups.kind;
  const names = kind
    ? [
        kind === 'notes'
          ? 'search_notes'
          : kind === 'tasks'
            ? 'search_tasks'
            : 'search_activities',
      ]
    : ['search_notes', 'search_tasks', 'search_activities'];

  return {
    ok: true,
    summary: `Read the open ${objectName}.`,
    tools: names.map((name) => ({
      name,
      args: { query: 'record', recordRef: 'open', limit: 8 },
    })),
  };
}

function timelineSearch(
  name: 'search_notes' | 'search_tasks' | 'search_activities',
  label: string,
  query: string,
): LlmPlan {
  const trimmed = trimValue(query);

  return {
    ok: true,
    summary: `Search ${label} for ${trimmed}.`,
    tools: [{ name, args: { query: trimmed } }],
  };
}

function updateTool(groups: Record<string, string | undefined>): ToolCall {
  const field = groups.field ?? '';
  const args: Record<string, unknown> = {
    object: objectNameFor(groups.object ?? ''),
    field,
    value: fieldValue(field, groups.value),
  };

  if (groups.id) {
    args.id = groups.id;
  }

  if (groups.query) {
    args.query = groups.query;
  }

  if (groups.ifMatch) {
    args.ifMatch = groups.ifMatch;
  }

  return { name: 'update_record', args };
}

function objectNameFor(word: string): TwentyObjectName {
  const normalized = word.toLowerCase();

  if (
    normalized === 'person' ||
    normalized === 'people' ||
    normalized === 'persons'
  ) {
    return 'person';
  }

  if (
    normalized === 'opportunity' ||
    normalized === 'opportunities' ||
    normalized === 'deals'
  ) {
    return 'opportunity';
  }

  return 'company';
}

function parseMoney(
  amount: string,
  multiplier: string | undefined,
): number | undefined {
  const numeric = Number(amount.replace(/,/g, ''));

  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }

  return multiplier ? numeric * 1000 : numeric;
}

function fieldValue(field: string, value: string | undefined): string | number {
  if (field === 'amount') {
    return Number((value ?? '').replace(/,/g, ''));
  }

  return trimValue(value ?? '');
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
