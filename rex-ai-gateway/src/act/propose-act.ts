import { randomUUID } from 'node:crypto';

import { CrmNotFoundError, CrmPreconditionError } from '../twenty/crm-errors';
import type { CreatedRecord, TwentyCrmClient } from '../twenty/twenty-crm-client';
import type { ProposalStore } from '../http/proposal-store';
import type { LlmProvider } from '../llm/llm-provider';
import { bindOpenRecord } from './bind-open-record';
import { CREATE_NEW_CHOICE_ID, createNewLabel, createNewTools, matchDetail, matchLabel } from './create-new-choice';
import { groundModelPlan } from './ground-model-plan';
import { loadVisibleSnapshot, publicVisibleRecords } from './visible-snapshot';
import type { PendingChoice } from './pending-choice';
import { assertToolPermitted, catalogForAudience, loadAudience, type AudienceLoad } from './permissions';
import { describeTool, summarizeLines } from './describe-tool';
import { parseGatewayRequest, type OpenRecordContext } from './parse-request';
import {
  MAX_TOOLS_PER_REQUEST,
  refusal,
  upstreamFailure,
  type ActRefusal,
  type ActUpstreamFailure,
  type PlanProposal,
  type PlanResult,
  type ProposalLine,
  type ToolCall,
} from './types';
import { validateTool, type ValidatedTool } from './validate-tool';
import type { ExecuteActOptions } from './execute-act';

export type ProposeActOptions = ExecuteActOptions & {
  proposals?: ProposalStore;
  memberId?: string;
  actorMemberId?: string;
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

  const workspaceRefusal = rejectForeignWorkspace(parsed.workspaceId, options.boundWorkspaceId);

  if (workspaceRefusal) {
    return workspaceRefusal;
  }

  const audience = await loadAudience(client);
  const catalog = catalogForAudience(audience);

  if ('refused' in catalog) {
    return catalog;
  }

  const openRecord = await loadOpenRecord(client, parsed.workspaceId, parsed.openRecord, parsed);

  if (openRecord && 'refused' in openRecord) {
    return openRecord;
  }

  if (parsed.tools && parsed.tools.length > 0) {
    return previewTools(client, parsed.workspaceId, parsed.tools, options, audience, openRecord);
  }

  if (parsed.intent === undefined || parsed.intent.trim().length === 0) {
    return refusal('invalid_request', 'Provide an intent string.');
  }

  let planned;
  const snapshot = await loadVisibleSnapshot(client, parsed.workspaceId, audience);

  try {
    planned = await llm.plan({
      intent: parsed.intent,
      workspaceId: parsed.workspaceId,
      client,
      catalog,
      visibleRecords: publicVisibleRecords(snapshot),
      ...(openRecord ? { openRecord: { objectName: openRecord.objectName, label: openRecord.label } } : {}),
    });
  } catch (error) {
    return upstreamFailure(error, 0);
  }

  if (!planned.ok) {
    return planned;
  }

  if (planned.tools.length === 0) {
    return refusal('unmapped_intent', 'The model response did not include tools.');
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

  return previewTools(client, parsed.workspaceId, grounded, options, audience, openRecord);
}

async function loadOpenRecord(
  client: TwentyCrmClient,
  workspaceId: string,
  openRecord: OpenRecordContext | undefined,
  parsed: { tools?: unknown[]; intent?: string },
): Promise<
  (OpenRecordContext & { label: string }) | undefined | ActRefusal | ActUpstreamFailure
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
  const intentOnly = parsed.intent !== undefined && (!parsed.tools || parsed.tools.length === 0);
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
      return refusal('not_found', 'The open record was not found.', { toolName: 'update_record' });
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

  const lines: ProposalLine[] = [];
  const normalized: ToolCall[] = [];
  const memberId = options.memberId ?? 'member_direct';

  try {
    for (const tool of validated) {
      const named = await resolveNamedRecord(client, workspaceId, tool, validated.length);

      if ('refused' in named) {
        return named;
      }

      if ('choice' in named) {
        return storeChoice(workspaceId, memberId, named.choice, options.proposals);
      }

      const current = await enrichUpdate(client, workspaceId, named);

      if ('refused' in current) {
        return current;
      }

      lines.push(describeTool(named, current.record));
      normalized.push(toolCallFromValidated(named));
    }
  } catch (error) {
    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', error.message, { toolName: 'update_record' });
    }

    if (error instanceof CrmPreconditionError) {
      return refusal('precondition_failed', error.message, { toolName: 'update_record' });
    }

    return upstreamFailure(error, 0);
  }

  const stored = options.proposals?.save(memberId, workspaceId, normalized);

  if (options.proposals && !stored) {
    return refusal(
      'invalid_request',
      'Too many pending previews. Confirm or discard one before proposing another.',
    );
  }

  const proposal: PlanProposal = {
    id: stored?.id ?? `proposal_${randomUUID()}`,
    summary: summarizeLines(lines),
    tools: normalized,
    lines,
  };

  return { ok: true, workspaceId, proposal };
}

function assignActor(tool: ValidatedTool, actorMemberId: string | undefined): ValidatedTool {
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
  toolCount: number,
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
    (tool.name !== 'update_record' && tool.name !== 'create_note' && tool.name !== 'archive_record')
  ) {
    return tool;
  }

  const objectName =
    tool.name === 'create_note' ? tool.input.targetObject : tool.input.objectName;
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
    if (toolCount > 1) {
      return refusal(
        'ambiguous_intent',
        `Several ${objectName} records match “${query}”. Name one record id before combining actions.`,
        { toolName: tool.name },
      );
    }

    const draft: Omit<PendingChoice, 'candidates' | 'createTools' | 'query'> & {
      query: string;
    } = {
      kind: tool.name === 'create_note' ? 'note' : tool.name === 'archive_record' ? 'archive' : 'update',
      objectName,
      field: tool.name === 'update_record' ? tool.input.field : '',
      value: tool.name === 'update_record' ? tool.input.value : '',
      ...(tool.name === 'create_note' && tool.input.title ? { title: tool.input.title } : {}),
      body: tool.name === 'create_note' ? tool.input.body : '',
      query,
    };
    const createTools = draft.kind === 'archive' ? undefined : createNewTools(draft);

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
            ? [{ id: CREATE_NEW_CHOICE_ID, label: createNewLabel(draft), etag: 'create' }]
            : []),
        ],
      },
    };
  }

  const match = matches[0];

  if (!match) {
    return refusal('not_found', `No ${objectName} matches “${query}”.`, { toolName: tool.name });
  }

  if (tool.name === 'update_record') {
    return { ...tool, input: { ...tool.input, id: match.id, query: undefined } };
  }

  if (tool.name === 'archive_record') {
    return { ...tool, input: { ...tool.input, id: match.id, query: undefined } };
  }

  return { ...tool, input: { ...tool.input, targetId: match.id, targetQuery: undefined } };
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
  const createHint = choice.createTools && choice.createTools.length > 0 ? ', or create a new one' : '';
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
        summary: candidate.detail ? `${candidate.label} · ${candidate.detail}` : candidate.label,
      })),
      choice: {
        prompt: summary,
        candidates: choice.candidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          objectName: choice.objectName,
          action: candidate.id === CREATE_NEW_CHOICE_ID ? ('create' as const) : ('use' as const),
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
  if ((tool.name !== 'update_record' && tool.name !== 'archive_record') || !tool.input.id) {
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
