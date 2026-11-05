import { randomUUID } from 'node:crypto';

import { CrmNotFoundError, CrmPreconditionError } from '../twenty/crm-errors';
import type {
  CreatedRecord,
  TwentyCrmClient,
} from '../twenty/twenty-crm-client';
import type { ProposalStore } from '../http/proposal-store';
import type { SkillStore } from '../http/skill-store';
import type { LlmProvider } from '../llm/llm-provider';
import { bindOpenRecord } from './bind-open-record';
import {
  CREATE_NEW_CHOICE_ID,
  createNewLabel,
  createNewTools,
  createToolsForGroup,
  matchDetail,
  matchLabel,
} from './create-new-choice';
import { groundModelPlan } from './ground-model-plan';
import { loadVisibleSnapshot, publicVisibleRecords } from './visible-snapshot';
import type {
  ChoiceGroup,
  PendingBatch,
  PendingBatchStep,
  PendingChoice,
} from './pending-choice';
import {
  assertToolPermitted,
  catalogForAudience,
  loadAudience,
  type AudienceLoad,
} from './permissions';
import { answerReads, isReadTool } from './answer-reads';
import { captureToTools } from './capture-text';
import { describeTool, partialsForRole, summarizeLines } from './describe-tool';
import { changesFromSlots } from './preview-changes';
import { collectWarnings } from './preview-warnings';
import { withoutLiveEtag } from './strip-live-etag';
import type { PartialToolCall } from '../llm/llm-provider';
import { parseGatewayRequest, type OpenRecordContext } from './parse-request';
import {
  MAX_TOOLS_PER_REQUEST,
  refusal,
  upstreamFailure,
  type ActRefusal,
  type ActUpstreamFailure,
  type PlanAnswer,
  type PlanChoiceCandidate,
  type PlanProposal,
  type PlanResult,
  type ProposalChange,
  type ProposalLine,
  type ProposalWarning,
  type ToolCall,
} from './types';
import { validateTool, type ValidatedTool } from './validate-tool';
import type { ExecuteActOptions } from './execute-act';

export type ProposeActOptions = ExecuteActOptions & {
  proposals?: ProposalStore;
  skills?: SkillStore;
  memberId?: string;
  actorMemberId?: string;
  onPartial?: (tools: PartialToolCall[]) => void;
};

export async function proposeAct(
  body: unknown,
  client: TwentyCrmClient,
  llm: LlmProvider,
  options: ProposeActOptions = {},
): Promise<PlanResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  const workspaceRefusal = rejectForeignWorkspace(
    parsed.workspaceId,
    options.boundWorkspaceId,
  );

  if (workspaceRefusal) {
    return workspaceRefusal;
  }

  const audience = await loadAudience(client);
  const catalog = catalogForAudience(audience);

  if ('refused' in catalog) {
    return catalog;
  }

  const openRecord = await loadOpenRecord(
    client,
    parsed.workspaceId,
    parsed.openRecord,
    parsed,
  );

  if (openRecord && 'refused' in openRecord) {
    return openRecord;
  }

  if (parsed.tools && parsed.tools.length > 0) {
    return previewTools(
      client,
      parsed.workspaceId,
      parsed.tools,
      options,
      audience,
      openRecord,
    );
  }

  if (parsed.capture) {
    const captured = captureToTools(parsed.capture, audience);

    if ('refused' in captured) {
      return captured;
    }

    return previewTools(
      client,
      parsed.workspaceId,
      captured,
      options,
      audience,
      undefined,
    );
  }

  if (parsed.skillId) {
    const skill = options.skills?.read(parsed.skillId, options.memberId ?? '');

    if (!skill) {
      return refusal('not_found', 'No saved skill with that id.', {
        toolName: 'create_person',
      });
    }

    if (skill.workspaceId !== parsed.workspaceId) {
      return refusal(
        'cross_workspace',
        'This skill belongs to a different workspace.',
      );
    }

    return previewTools(
      client,
      parsed.workspaceId,
      withoutLiveEtag(skill.tools),
      options,
      audience,
      undefined,
    );
  }

  if (parsed.intent === undefined || parsed.intent.trim().length === 0) {
    return refusal('invalid_request', 'Provide an intent string.');
  }

  let planned;
  const snapshot = await loadVisibleSnapshot(
    client,
    parsed.workspaceId,
    audience,
  );
  const allowed = new Set<string>(catalog.tools.map((tool) => tool.name));
  const planInput = {
    intent: parsed.intent,
    workspaceId: parsed.workspaceId,
    client,
    catalog,
    visibleRecords: publicVisibleRecords(snapshot),
    ...(openRecord
      ? {
          openRecord: {
            objectName: openRecord.objectName,
            label: openRecord.label,
          },
        }
      : {}),
  };

  const emitPartial = options.onPartial
    ? (tools: PartialToolCall[]) => {
        options.onPartial?.(
          partialsForRole(tools, parsed.workspaceId, audience, allowed),
        );
      }
    : undefined;

  try {
    planned =
      emitPartial && llm.planStream
        ? await llm.planStream(planInput, emitPartial)
        : await llm.plan(planInput);
  } catch (error) {
    return upstreamFailure(error, 0);
  }

  if (!planned.ok) {
    return planned;
  }

  if (planned.tools.length === 0) {
    return refusal(
      'unmapped_intent',
      'The model response did not include tools.',
    );
  }

  if (planned.tools.length > MAX_TOOLS_PER_REQUEST) {
    return refusal(
      'invalid_request',
      `A plan can include at most ${MAX_TOOLS_PER_REQUEST} tools.`,
    );
  }

  const grounded = groundModelPlan(planned.tools, parsed.intent, snapshot);

  if ('refused' in grounded) {
    return grounded;
  }

  return previewTools(
    client,
    parsed.workspaceId,
    grounded,
    options,
    audience,
    openRecord,
  );
}

export async function reproposeAct(
  body: unknown,
  client: TwentyCrmClient,
  options: ProposeActOptions = {},
): Promise<PlanResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  const workspaceRefusal = rejectForeignWorkspace(
    parsed.workspaceId,
    options.boundWorkspaceId,
  );

  if (workspaceRefusal) {
    return workspaceRefusal;
  }

  if (!parsed.proposalId) {
    return refusal(
      'invalid_request',
      'proposalId is required to reload a preview.',
    );
  }

  if (!options.proposals || !options.memberId) {
    return refusal('invalid_request', 'This preview cannot be reloaded.');
  }

  const peeked = options.proposals.peek(
    parsed.proposalId,
    parsed.workspaceId,
    options.memberId,
    parsed.choiceId,
    parsed.choices,
  );

  if (!peeked.ok) {
    if (peeked.reason === 'choice') {
      return refusal(
        'confirmation_required',
        'Choose a record for each name, then confirm. Nothing was written.',
      );
    }

    return refusal(
      'not_found',
      'That preview expired or does not exist. Nothing was written.',
    );
  }

  const audience = await loadAudience(client);

  if (audience.kind === 'unavailable') {
    return refusal(
      'forbidden',
      'Permissions could not be read from Twenty, so this preview was not reloaded.',
    );
  }

  return previewTools(
    client,
    parsed.workspaceId,
    withoutLiveEtag(peeked.proposal.tools),
    options,
    audience,
    undefined,
  );
}

async function loadOpenRecord(
  client: TwentyCrmClient,
  workspaceId: string,
  openRecord: OpenRecordContext | undefined,
  parsed: { tools?: unknown[]; intent?: string },
): Promise<
  | (OpenRecordContext & { label: string })
  | undefined
  | ActRefusal
  | ActUpstreamFailure
> {
  if (!openRecord) {
    return undefined;
  }

  const toolsUseOpenRecord =
    Array.isArray(parsed.tools) &&
    parsed.tools.some(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        'args' in tool &&
        typeof (tool as { args?: unknown }).args === 'object' &&
        (tool as { args?: { recordRef?: unknown } }).args?.recordRef === 'open',
    );
  const intentOnly =
    parsed.intent !== undefined && (!parsed.tools || parsed.tools.length === 0);
  const needed = toolsUseOpenRecord || intentOnly;

  if (!needed) {
    return undefined;
  }

  try {
    const record = await client.getRecord({
      workspaceId,
      objectName: openRecord.objectName,
      id: openRecord.recordId,
    });

    return { ...openRecord, label: record.label };
  } catch (error) {
    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', 'The open record was not found.', {
        toolName: 'update_record',
      });
    }

    return upstreamFailure(error, 0);
  }
}

async function previewTools(
  client: TwentyCrmClient,
  workspaceId: string,
  tools: ToolCall[],
  options: ProposeActOptions,
  audience: AudienceLoad,
  openRecord: (OpenRecordContext & { label: string }) | undefined,
): Promise<PlanResult> {
  const validated: ValidatedTool[] = [];

  for (const tool of tools) {
    const result = validateTool(tool, workspaceId);

    if ('refused' in result) {
      return result;
    }

    const permission = assertToolPermitted(result, audience);

    if (permission) {
      return permission;
    }

    const bound = bindOpenRecord(result, openRecord);

    if ('refused' in bound) {
      return bound;
    }

    validated.push(assignActor(bound, options.actorMemberId));
  }

  const reads = validated.filter(isReadTool);
  const writes = validated.filter((tool) => !isReadTool(tool));
  let answer: PlanAnswer | undefined;

  if (reads.length > 0) {
    const answered = await answerReads(client, workspaceId, reads);

    if ('reason' in answered) {
      return answered;
    }

    answer = answered;
  }

  if (writes.length === 0) {
    return {
      ok: true,
      workspaceId,
      summary: answer?.summary ?? 'No matching records.',
      ...(answer ? { answer } : {}),
    };
  }

  const memberId = options.memberId ?? 'member_direct';
  const slots: PreviewSlot[] = [];
  const bulkTools = new Set<ValidatedTool>();
  let changes: ProposalChange[] = [];
  let warnings: ProposalWarning[] = [];

  try {
    const expanded = await expandMatchingUpdates(
      client,
      workspaceId,
      writes,
      bulkTools,
    );

    if ('refused' in expanded) {
      return expanded;
    }

    for (const tool of expanded) {
      const named = await resolveNamedRecord(client, workspaceId, tool);

      if ('refused' in named) {
        return named;
      }

      if ('choice' in named) {
        slots.push({ type: 'choice', draft: named.choice });
        continue;
      }

      const current = await enrichUpdate(client, workspaceId, named);

      if ('refused' in current) {
        return current;
      }

      slots.push({
        type: 'ready',
        tool: named,
        ...(current.record ? { record: current.record } : {}),
      });
    }

    changes = changesFromSlots(slots);
    warnings = await collectWarnings(client, workspaceId, slots);
  } catch (error) {
    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', error.message, { toolName: 'update_record' });
    }

    if (error instanceof CrmPreconditionError) {
      return refusal('precondition_failed', error.message, {
        toolName: 'update_record',
      });
    }

    return upstreamFailure(error, 0);
  }

  const choiceCount = slots.filter((slot) => slot.type === 'choice').length;

  const extras = { changes, warnings };

  if (choiceCount === 1 && slots.length === 1 && slots[0]?.type === 'choice') {
    return withAnswer(
      storeChoice(workspaceId, memberId, slots[0].draft, options.proposals),
      answer,
    );
  }

  if (choiceCount > 0) {
    return withAnswer(
      storeBatch(
        workspaceId,
        memberId,
        slots,
        options.proposals,
        bulkTools,
        extras,
      ),
      answer,
    );
  }

  const lines: ProposalLine[] = [];
  const normalized: ToolCall[] = [];
  const seenRecord = new Set<string>();

  for (const slot of slots) {
    if (slot.type !== 'ready') {
      continue;
    }

    markChained(slot.tool, seenRecord);
    lines.push(
      describeTool(slot.tool, slot.record, {
        disambiguate: bulkTools.has(slot.tool),
      }),
    );
    normalized.push(toolCallFromValidated(slot.tool));
  }

  return withAnswer(
    storePreview(
      workspaceId,
      memberId,
      normalized,
      lines,
      options.proposals,
      extras,
    ),
    answer,
  );
}

async function expandMatchingUpdates(
  client: TwentyCrmClient,
  workspaceId: string,
  tools: ValidatedTool[],
  bulkTools: Set<ValidatedTool>,
): Promise<ValidatedTool[] | ActRefusal> {
  const expanded: ValidatedTool[] = [];

  for (const tool of tools) {
    if (tool.name !== 'update_matching_records') {
      expanded.push(tool);
      continue;
    }

    const matches = await client.searchRecords({
      workspaceId,
      objectName: tool.input.objectName,
      query: tool.input.query ?? '',
      limit: MAX_TOOLS_PER_REQUEST + 1,
    });

    if (matches.length === 0) {
      return refusal(
        'not_found',
        `No ${tool.input.objectName} matches “${tool.input.query ?? ''}”.`,
        {
          toolName: tool.name,
        },
      );
    }

    if (
      matches.length > MAX_TOOLS_PER_REQUEST ||
      expanded.length + matches.length > MAX_TOOLS_PER_REQUEST
    ) {
      return refusal(
        'invalid_request',
        `This matches ${matches.length} ${tool.input.objectName} records. A preview lists at most ${MAX_TOOLS_PER_REQUEST}. Narrow the query. Nothing was written.`,
        { toolName: tool.name },
      );
    }

    for (const match of matches) {
      const update: ValidatedTool = {
        name: 'update_record',
        input: {
          objectName: tool.input.objectName,
          id: match.id,
          field: tool.input.field,
          value: tool.input.value,
        },
      };
      bulkTools.add(update);
      expanded.push(update);
    }
  }

  return expanded;
}

function assignActor(
  tool: ValidatedTool,
  actorMemberId: string | undefined,
): ValidatedTool {
  if (tool.name !== 'update_record' || tool.input.value !== 'me') {
    return tool;
  }

  if (tool.input.field !== 'owner' && tool.input.field !== 'accountOwner') {
    return tool;
  }

  if (!actorMemberId) {
    return tool;
  }

  return {
    ...tool,
    input: { ...tool.input, value: actorMemberId },
  };
}

async function resolveNamedRecord(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<ValidatedTool | { choice: PendingChoice } | ActRefusal> {
  const query =
    tool.name === 'update_record' || tool.name === 'archive_record'
      ? tool.input.query
      : tool.name === 'create_note'
        ? tool.input.targetQuery
        : undefined;
  const hasId =
    tool.name === 'update_record' || tool.name === 'archive_record'
      ? Boolean(tool.input.id)
      : tool.name === 'create_note'
        ? Boolean(tool.input.targetId)
        : true;

  if (
    !query ||
    hasId ||
    (tool.name !== 'update_record' &&
      tool.name !== 'create_note' &&
      tool.name !== 'archive_record')
  ) {
    return tool;
  }

  const objectName =
    tool.name === 'create_note'
      ? tool.input.targetObject
      : tool.input.objectName;
  const matches = await client.searchRecords({
    workspaceId,
    objectName,
    query,
    limit: 10,
  });

  if (matches.length === 0) {
    return refusal('not_found', `No ${objectName} matches “${query}”.`, {
      toolName: tool.name,
    });
  }

  if (matches.length > 1) {
    const draft: Omit<PendingChoice, 'candidates' | 'createTools' | 'query'> & {
      query: string;
    } = {
      kind:
        tool.name === 'create_note'
          ? 'note'
          : tool.name === 'archive_record'
            ? 'archive'
            : 'update',
      objectName,
      field: tool.name === 'update_record' ? tool.input.field : '',
      value: tool.name === 'update_record' ? tool.input.value : '',
      ...(tool.name === 'create_note' && tool.input.title
        ? { title: tool.input.title }
        : {}),
      body: tool.name === 'create_note' ? tool.input.body : '',
      query,
    };
    const createTools =
      draft.kind === 'archive' ? undefined : createNewTools(draft);

    return {
      choice: {
        ...draft,
        ...(createTools ? { createTools } : {}),
        candidates: [
          ...matches.map((record) => ({
            id: record.id,
            label: matchLabel(record),
            detail: matchDetail(record),
            etag: record.etag,
          })),
          ...(createTools
            ? [
                {
                  id: CREATE_NEW_CHOICE_ID,
                  label: createNewLabel(draft),
                  etag: 'create',
                },
              ]
            : []),
        ],
      },
    };
  }

  const match = matches[0];

  if (!match) {
    return refusal('not_found', `No ${objectName} matches “${query}”.`, {
      toolName: tool.name,
    });
  }

  if (tool.name === 'update_record') {
    return {
      ...tool,
      input: { ...tool.input, id: match.id, query: undefined },
    };
  }

  if (tool.name === 'archive_record') {
    return {
      ...tool,
      input: { ...tool.input, id: match.id, query: undefined },
    };
  }

  return {
    ...tool,
    input: { ...tool.input, targetId: match.id, targetQuery: undefined },
  };
}

function storeChoice(
  workspaceId: string,
  memberId: string,
  choice: PendingChoice,
  proposals: ProposalStore | undefined,
): PlanResult {
  const stored = proposals?.save(memberId, workspaceId, [], choice);
  const objectLabel =
    choice.objectName === 'person'
      ? 'people'
      : choice.objectName === 'company'
        ? 'companies'
        : 'opportunities';
  const named = choice.query ? ` “${choice.query}”` : '';
  const createHint =
    choice.createTools && choice.createTools.length > 0
      ? ', or create a new one'
      : '';
  const summary = `Several ${objectLabel} match${named}. Choose one${createHint}, then confirm.`;

  if (proposals && !stored) {
    return refusal(
      'invalid_request',
      'Too many pending previews. Confirm or discard one before proposing another.',
    );
  }

  return {
    ok: true,
    workspaceId,
    proposal: {
      id: stored?.id ?? `proposal_${randomUUID()}`,
      summary,
      tools: [],
      lines: choice.candidates.map((candidate) => ({
        tool:
          choice.kind === 'note'
            ? 'create_note'
            : choice.kind === 'archive'
              ? 'archive_record'
              : 'update_record',
        summary: candidate.detail
          ? `${candidate.label} · ${candidate.detail}`
          : candidate.label,
      })),
      choice: {
        prompt: summary,
        candidates: choice.candidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          objectName: choice.objectName,
          action:
            candidate.id === CREATE_NEW_CHOICE_ID
              ? ('create' as const)
              : ('use' as const),
          ...(candidate.detail ? { detail: candidate.detail } : {}),
        })),
      },
    },
  };
}

async function enrichUpdate(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<{ record?: CreatedRecord } | ActRefusal> {
  if (
    (tool.name !== 'update_record' && tool.name !== 'archive_record') ||
    !tool.input.id
  ) {
    return {};
  }

  const record = await client.getRecord({
    workspaceId,
    objectName: tool.input.objectName,
    id: tool.input.id,
  });

  if (tool.input.ifMatch && record.etag !== tool.input.ifMatch) {
    return refusal(
      'precondition_failed',
      `If-Match ${tool.input.ifMatch} does not match the current ${tool.input.objectName} version ${record.etag}.`,
      { toolName: 'update_record' },
    );
  }

  if (!tool.input.ifMatch) {
    tool.input.ifMatch = record.etag;
  }

  return { record };
}

function toolCallFromValidated(tool: ValidatedTool): ToolCall {
  if (tool.name === 'search_records') {
    return {
      name: tool.name,
      args: {
        object: tool.input.objectName,
        query: tool.input.query,
        limit: tool.input.limit,
      },
    };
  }

  if (
    tool.name === 'search_notes' ||
    tool.name === 'search_tasks' ||
    tool.name === 'search_activities'
  ) {
    return {
      name: tool.name,
      args: {
        query: tool.input.query,
        limit: tool.input.limit,
        ...(tool.input.recordId ? { recordId: tool.input.recordId } : {}),
      },
    };
  }

  if (tool.name === 'update_matching_records') {
    return {
      name: tool.name,
      args: {
        object: tool.input.objectName,
        query: tool.input.query,
        field: tool.input.field,
        value: tool.input.value,
      },
    };
  }

  if (tool.name === 'update_record') {
    return {
      name: tool.name,
      args: {
        object: tool.input.objectName,
        id: tool.input.id,
        field: tool.input.field,
        value: tool.input.value,
        ifMatch: tool.input.ifMatch,
      },
    };
  }

  if (tool.name === 'archive_record') {
    return {
      name: tool.name,
      args: {
        object: tool.input.objectName,
        id: tool.input.id,
        ifMatch: tool.input.ifMatch,
      },
    };
  }

  if (tool.name === 'create_note') {
    return {
      name: tool.name,
      args: {
        ...(tool.input.title ? { title: tool.input.title } : {}),
        body: tool.input.body,
        targetObject: tool.input.targetObject,
        targetId: tool.input.targetId,
      },
    };
  }

  return { name: tool.name, args: { ...tool.input } };
}

type PreviewSlot =
  | { type: 'ready'; tool: ValidatedTool; record?: CreatedRecord }
  | { type: 'choice'; draft: PendingChoice };

function storePreview(
  workspaceId: string,
  memberId: string,
  tools: ToolCall[],
  lines: ProposalLine[],
  proposals: ProposalStore | undefined,
  extras?: PreviewExtras,
): PlanResult {
  const stored = proposals?.save(memberId, workspaceId, tools);

  if (proposals && !stored) {
    return refusal(
      'invalid_request',
      'Too many pending previews. Confirm or discard one before proposing another.',
    );
  }

  return {
    ok: true,
    workspaceId,
    proposal: {
      id: stored?.id ?? `proposal_${randomUUID()}`,
      summary: summarizeLines(lines),
      tools,
      lines,
      ...previewExtras(extras),
    },
  };
}

type PreviewExtras = {
  changes?: ProposalChange[];
  warnings?: ProposalWarning[];
};

function previewExtras(
  extras: PreviewExtras | undefined,
): Pick<PlanProposal, 'changes' | 'warnings'> {
  return {
    ...(extras?.changes && extras.changes.length > 0
      ? { changes: extras.changes }
      : {}),
    ...(extras?.warnings && extras.warnings.length > 0
      ? { warnings: extras.warnings }
      : {}),
  };
}

function withAnswer(
  result: PlanResult,
  answer: PlanAnswer | undefined,
): PlanResult {
  if (!result.ok || !answer) {
    return result;
  }

  return { ...result, answer };
}

function storeBatch(
  workspaceId: string,
  memberId: string,
  slots: PreviewSlot[],
  proposals: ProposalStore | undefined,
  bulkTools: Set<ValidatedTool>,
  extras?: PreviewExtras,
): PlanResult {
  const groups: Array<ChoiceGroup & { key: string }> = [];
  const steps: PendingBatchStep[] = [];
  const lines: ProposalLine[] = [];
  const seenRecord = new Set<string>();

  for (const slot of slots) {
    if (slot.type === 'ready') {
      markChained(slot.tool, seenRecord);
      lines.push(
        describeTool(slot.tool, slot.record, {
          disambiguate: bulkTools.has(slot.tool),
        }),
      );
      steps.push({ type: 'tool', tool: toolCallFromValidated(slot.tool) });
      continue;
    }

    const key =
      slot.draft.kind === 'update'
        ? `update:${slot.draft.objectName}:${slot.draft.query ?? ''}`
        : `solo:${groups.length}:${slot.draft.kind}:${slot.draft.objectName}:${slot.draft.query ?? ''}`;
    let group = groups.find((item) => item.key === key);

    if (!group) {
      group = {
        key,
        id: String(groups.length),
        kind: slot.draft.kind,
        objectName: slot.draft.objectName,
        query: slot.draft.query ?? '',
        updates: [],
        ...(slot.draft.title ? { title: slot.draft.title } : {}),
        body: slot.draft.body,
        candidates: slot.draft.candidates,
      };
      groups.push(group);
    }

    group.updates.push({ field: slot.draft.field, value: slot.draft.value });
    steps.push({
      type: 'choice',
      groupId: group.id,
      updateIndex: group.updates.length - 1,
    });
  }

  for (const group of groups) {
    const createTools = createToolsForGroup(group);
    group.createTools = createTools;
    if (!createTools) {
      group.candidates = group.candidates.filter(
        (candidate) => candidate.id !== CREATE_NEW_CHOICE_ID,
      );
    }
  }

  const publicGroups = groups.map((group) => ({
    id: group.id,
    prompt: groupPrompt(group),
    candidates: toPublicCandidates(group),
  }));
  const summary = publicGroups.map((group) => group.prompt).join(' ');

  if (lines.length === 0) {
    lines.push({
      tool:
        groups[0]?.kind === 'note'
          ? 'create_note'
          : groups[0]?.kind === 'archive'
            ? 'archive_record'
            : 'update_record',
      summary,
    });
  }

  const pending: PendingBatch = {
    kind: 'batch',
    groups: groups.map(({ key: _key, ...group }) => group),
    steps,
  };
  const stored = proposals?.save(memberId, workspaceId, [], pending);

  if (proposals && !stored) {
    return refusal(
      'invalid_request',
      'Too many pending previews. Confirm or discard one before proposing another.',
    );
  }

  return {
    ok: true,
    workspaceId,
    proposal: {
      id: stored?.id ?? `proposal_${randomUUID()}`,
      summary,
      tools: [],
      lines,
      ...previewExtras(extras),
      choice: {
        prompt: summary,
        candidates: publicGroups[0]?.candidates ?? [],
        groups: publicGroups,
      },
    },
  };
}

function groupPrompt(group: ChoiceGroup): string {
  const objectLabel =
    group.objectName === 'person'
      ? 'people'
      : group.objectName === 'company'
        ? 'companies'
        : 'opportunities';
  const named = group.query ? ` “${group.query}”` : '';
  const createHint =
    group.createTools && group.createTools.length > 0
      ? ', or create a new one'
      : '';
  const fields =
    group.kind === 'update' && group.updates.length > 1
      ? ` The ${group.updates.length} field changes use the record you pick.`
      : '';

  return `Several ${objectLabel} match${named}. Choose one${createHint}, then confirm.${fields}`;
}

function toPublicCandidates(group: ChoiceGroup): PlanChoiceCandidate[] {
  return group.candidates.map((candidate) => ({
    id: candidate.id,
    label: candidate.label,
    objectName: group.objectName,
    action:
      candidate.id === CREATE_NEW_CHOICE_ID
        ? ('create' as const)
        : ('use' as const),
    ...(candidate.detail ? { detail: candidate.detail } : {}),
  }));
}

function markChained(tool: ValidatedTool, seen: Set<string>): void {
  if (
    (tool.name !== 'update_record' && tool.name !== 'archive_record') ||
    !tool.input.id
  ) {
    return;
  }

  const key = `${tool.input.objectName}:${tool.input.id}`;

  if (seen.has(key)) {
    tool.input.ifMatch = 'chained';
  }

  seen.add(key);
}

function rejectForeignWorkspace(
  workspaceId: string,
  boundWorkspaceId: string | undefined,
): ActRefusal | undefined {
  if (boundWorkspaceId && workspaceId !== boundWorkspaceId) {
    return refusal(
      'cross_workspace',
      `Request workspace "${workspaceId}" does not match the gateway workspace "${boundWorkspaceId}".`,
    );
  }

  return undefined;
}
