import {
  CrmNotFoundError,
  CrmPartialWriteError,
  CrmPreconditionError,
} from '../twenty/crm-errors';
import { UnsafeSearchQueryError } from '../twenty/safe-search';
import type {
  CreatedRecord,
  TwentyCrmClient,
} from '../twenty/twenty-crm-client';
import { compensate, partialFailure } from './compensate';
import { mapIntentToTool } from './map-intent';
import { loadAudience, assertToolPermitted } from './permissions';
import { parseGatewayRequest } from './parse-request';
import { preflightRefs, resolveRelationId } from './resolve-refs';
import {
  refusal,
  upstreamFailure,
  type ActEffect,
  type ActRefusal,
  type ActResult,
  type ToolCall,
  type ToolResult,
} from './types';

export type SettledToolEvent = {
  index: number;
  total: number;
  result: ToolResult;
};
import { validateTool, type ValidatedTool } from './validate-tool';

export type ExecuteActOptions = {
  boundWorkspaceId?: string;
  onSettled?: (event: SettledToolEvent) => void;
};

export async function executeAct(
  body: unknown,
  client: TwentyCrmClient,
  options: ExecuteActOptions = {},
): Promise<ActResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  if (
    options.boundWorkspaceId &&
    parsed.workspaceId !== options.boundWorkspaceId
  ) {
    return refusal(
      'cross_workspace',
      `Request workspace "${parsed.workspaceId}" does not match the gateway workspace "${options.boundWorkspaceId}".`,
    );
  }

  const tools = resolveTools(parsed);

  if ('refused' in tools) {
    return tools;
  }

  const audience = await loadAudience(client);
  const validated: ValidatedTool[] = [];

  for (const tool of tools) {
    const result = validateTool(tool, parsed.workspaceId);

    if ('refused' in result) {
      return result;
    }

    const permission = assertToolPermitted(result, audience);

    if (permission) {
      return permission;
    }

    if (
      (result.name === 'update_record' || result.name === 'archive_record') &&
      result.input.useOpenRecord
    ) {
      return refusal(
        'ambiguous_intent',
        'This action refers to the open record. Propose it from that record page.',
        { toolName: result.name },
      );
    }

    if (
      result.name === 'create_note' &&
      (result.input.useOpenRecord || !result.input.targetId)
    ) {
      return refusal(
        'missing_required_fields',
        'Refusing create_note: missing required fields: targetId.',
        { toolName: 'create_note', missingFields: ['targetId'] },
      );
    }

    if (result.name === 'update_record' && !result.input.ifMatch) {
      return refusal(
        'missing_required_fields',
        'Refusing update_record: missing required fields: ifMatch.',
        { toolName: 'update_record', missingFields: ['ifMatch'] },
      );
    }

    if (result.name === 'update_record' && !result.input.id) {
      return refusal(
        'missing_required_fields',
        'Refusing update_record: missing required fields: id.',
        { toolName: 'update_record', missingFields: ['id'] },
      );
    }

    if (result.name === 'archive_record' && !result.input.ifMatch) {
      return refusal(
        'missing_required_fields',
        'Refusing archive_record: missing required fields: ifMatch.',
        { toolName: 'archive_record', missingFields: ['ifMatch'] },
      );
    }

    if (result.name === 'archive_record' && !result.input.id) {
      return refusal(
        'missing_required_fields',
        'Refusing archive_record: missing required fields: id.',
        { toolName: 'archive_record', missingFields: ['id'] },
      );
    }

    if (result.name === 'update_matching_records') {
      return refusal(
        'confirmation_required',
        'A bulk update is stored as one write per record. Propose it again so the preview lists every target.',
        { toolName: result.name },
      );
    }

    validated.push(result);
  }

  const refRefusal = preflightRefs(validated);

  if (refRefusal) {
    return refRefusal;
  }

  const results: ToolResult[] = [];
  const priorIds: Array<string | undefined> = [];
  const priorEtags: Array<string | undefined> = [];
  const effects: ActEffect[] = [];

  try {
    for (const tool of validated) {
      const resolved = resolveTool(tool, priorIds, priorEtags);

      if ('refused' in resolved) {
        const remaining = await compensate(client, parsed.workspaceId, effects);
        if (remaining.length > 0) {
          return partialFailure(
            resolved.message,
            remaining.map((failure) => failure.id),
          );
        }
        return refusal(
          resolved.reason,
          withRollback(resolved.message, effects.length),
          {
            toolName: resolved.toolName,
            missingFields: resolved.missingFields,
          },
        );
      }

      const fresh = applyPriorEtag(resolved, results);

      if ('refused' in fresh) {
        const remaining = await compensate(client, parsed.workspaceId, effects);
        if (remaining.length > 0) {
          return partialFailure(
            fresh.message,
            remaining.map((failure) => failure.id),
          );
        }
        return refusal(
          fresh.reason,
          withRollback(fresh.message, effects.length),
          {
            toolName: fresh.toolName,
            missingFields: fresh.missingFields,
          },
        );
      }

      const snapshot = await snapshotUpdate(client, parsed.workspaceId, fresh);
      const result = await dispatch(client, parsed.workspaceId, fresh);
      results.push(result);
      priorIds.push(recordId(result));
      priorEtags.push(
        result.status === 'found' ? undefined : result.record.etag,
      );
      effects.push(...effectsFor(fresh, result, snapshot));
      options.onSettled?.({
        index: results.length,
        total: validated.length,
        result,
      });
    }
  } catch (error) {
    const orphans =
      error instanceof CrmPartialWriteError ? error.remainingRecordIds : [];
    const remaining = [
      ...orphans,
      ...(await compensate(client, parsed.workspaceId, effects)).map(
        (failure) => failure.id,
      ),
    ];
    const message = errorMessage(error);

    if (remaining.length > 0 || error instanceof CrmPartialWriteError) {
      return partialFailure(message, remaining);
    }

    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', withRollback(message, effects.length), {
        toolName: 'update_record',
      });
    }

    if (error instanceof CrmPreconditionError) {
      return refusal(
        'precondition_failed',
        withRollback(message, effects.length),
        {
          toolName: 'update_record',
        },
      );
    }

    if (error instanceof UnsafeSearchQueryError) {
      return refusal('invalid_request', withRollback(message, effects.length), {
        toolName: 'search_records',
      });
    }

    return {
      ...upstreamFailure(error, 0),
      message: withRollback(upstreamFailure(error, 0).message, effects.length),
    };
  }

  return {
    ok: true,
    workspaceId: parsed.workspaceId,
    results,
    ...(effects.length > 0 ? { effects } : {}),
  };
}

function resolveTools(request: {
  tools?: ToolCall[];
  intent?: string;
}): ToolCall[] | ActRefusal {
  if (request.tools && request.tools.length > 0) {
    return request.tools;
  }

  if (request.intent !== undefined) {
    const mapped = mapIntentToTool(request.intent);

    if ('refused' in mapped) {
      return mapped;
    }

    return [mapped];
  }

  return refusal(
    'invalid_request',
    'Provide a tools array or an intent string.',
  );
}

function resolveTool(
  tool: ValidatedTool,
  priorIds: Array<string | undefined>,
  priorEtags: Array<string | undefined>,
): ValidatedTool | ActRefusal {
  if (tool.name === 'update_record' && tool.input.id?.startsWith('$')) {
    const resolvedId = resolveRelationId(tool.input.id, priorIds, tool.name);

    if (isRefusal(resolvedId) || !resolvedId) {
      return isRefusal(resolvedId)
        ? resolvedId
        : refusal(
            'invalid_request',
            `Refusing update_record: ${tool.input.id} did not resolve to a record id.`,
            {
              toolName: 'update_record',
            },
          );
    }

    const match = /^\$(\d+)$/.exec(tool.input.id);
    const etag = match?.[1] ? priorEtags[Number(match[1])] : undefined;

    if (tool.input.ifMatch !== 'created' || !etag) {
      return refusal(
        'invalid_request',
        `Refusing update_record: ${tool.input.id} has no etag from an earlier create.`,
        { toolName: 'update_record' },
      );
    }

    return { ...tool, input: { ...tool.input, id: resolvedId, ifMatch: etag } };
  }

  if (tool.name === 'create_person' && tool.input.companyId) {
    const companyId = resolveRelationId(
      tool.input.companyId,
      priorIds,
      tool.name,
    );

    if (typeof companyId !== 'string' && companyId !== undefined) {
      return companyId;
    }

    return {
      ...tool,
      input: { ...tool.input, ...(companyId ? { companyId } : {}) },
    };
  }

  if (tool.name === 'create_opportunity') {
    const companyId = resolveRelationId(
      tool.input.companyId,
      priorIds,
      tool.name,
    );
    const pointOfContactId = resolveRelationId(
      tool.input.pointOfContactId,
      priorIds,
      tool.name,
    );

    if (isRefusal(companyId)) {
      return companyId;
    }

    if (isRefusal(pointOfContactId)) {
      return pointOfContactId;
    }

    return {
      ...tool,
      input: {
        ...tool.input,
        ...(companyId ? { companyId } : {}),
        ...(pointOfContactId ? { pointOfContactId } : {}),
      },
    };
  }

  if (tool.name === 'create_note' && tool.input.targetId) {
    const targetId = resolveRelationId(
      tool.input.targetId,
      priorIds,
      tool.name,
    );

    if (isRefusal(targetId)) {
      return targetId;
    }

    return {
      ...tool,
      input: { ...tool.input, ...(targetId ? { targetId } : {}) },
    };
  }

  return tool;
}

async function dispatch(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<ToolResult> {
  switch (tool.name) {
    case 'create_person': {
      const record = await client.createPerson({ ...tool.input, workspaceId });
      return { tool: tool.name, status: 'created', record };
    }
    case 'create_company': {
      const record = await client.createCompany({ ...tool.input, workspaceId });
      return { tool: tool.name, status: 'created', record };
    }
    case 'create_opportunity': {
      const record = await client.createOpportunity({
        ...tool.input,
        workspaceId,
      });
      return { tool: tool.name, status: 'created', record };
    }
    case 'create_note': {
      if (!tool.input.targetId) {
        throw new Error('create_note is missing targetId.');
      }

      const record = await client.createNote({
        ...tool.input,
        workspaceId,
        targetId: tool.input.targetId,
      });
      return { tool: tool.name, status: 'created', record };
    }
    case 'search_records': {
      const records = await client.searchRecords({
        ...tool.input,
        workspaceId,
      });
      return { tool: tool.name, status: 'found', records };
    }
    case 'search_notes': {
      const records = await client.searchNotes({ ...tool.input, workspaceId });
      return { tool: tool.name, status: 'found', records };
    }
    case 'search_tasks': {
      const records = await client.searchTasks({ ...tool.input, workspaceId });
      return { tool: tool.name, status: 'found', records };
    }
    case 'search_activities': {
      const records = await client.searchActivities({
        ...tool.input,
        workspaceId,
      });
      return { tool: tool.name, status: 'found', records };
    }
    case 'update_matching_records':
      throw new Error(
        'update_matching_records must be expanded before confirm.',
      );
    case 'update_record': {
      const ifMatch = tool.input.ifMatch;

      if (!ifMatch) {
        throw new Error('update_record is missing ifMatch.');
      }

      const record = await client.updateRecord({
        workspaceId,
        objectName: tool.input.objectName,
        id: tool.input.id ?? '',
        field: tool.input.field,
        value: tool.input.value,
        ifMatch,
      });
      return { tool: tool.name, status: 'updated', record };
    }
    case 'archive_record': {
      const ifMatch = tool.input.ifMatch;

      if (!ifMatch || !tool.input.id) {
        throw new Error('archive_record is missing id or ifMatch.');
      }

      const record = await client.archiveRecord({
        workspaceId,
        objectName: tool.input.objectName,
        id: tool.input.id,
        ifMatch,
      });
      return { tool: tool.name, status: 'archived', record };
    }
  }
}

function applyPriorEtag(
  tool: ValidatedTool,
  results: ToolResult[],
): ValidatedTool | ActRefusal {
  if (tool.name === 'update_record') {
    return withFreshEtag(tool, results);
  }

  if (tool.name === 'archive_record') {
    return withFreshEtag(tool, results);
  }

  return tool;
}

function withFreshEtag<
  TTool extends ValidatedTool & { name: 'update_record' | 'archive_record' },
>(tool: TTool, results: ToolResult[]): TTool | ActRefusal {
  const prior = priorWrite(tool.input.objectName, tool.input.id, results);

  if (prior?.status === 'archived') {
    return refusal(
      'precondition_failed',
      `Refusing ${tool.name}: ${tool.input.id ?? 'the record'} was archived earlier in this preview, so a later write was not sent.`,
      { toolName: tool.name },
    );
  }

  if (prior && prior.status !== 'found') {
    return { ...tool, input: { ...tool.input, ifMatch: prior.record.etag } };
  }

  if (tool.input.ifMatch === 'chained') {
    return refusal(
      'precondition_failed',
      `Refusing ${tool.name}: ${tool.input.id ?? 'the record'} has no etag from an earlier write in this preview.`,
      { toolName: tool.name },
    );
  }

  return tool;
}

function priorWrite(
  objectName: string,
  id: string | undefined,
  results: ToolResult[],
): ToolResult | undefined {
  if (!id) {
    return undefined;
  }

  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];

    if (!result || result.status === 'found') {
      continue;
    }

    if (result.record.id === id && result.record.objectName === objectName) {
      return result;
    }
  }

  return undefined;
}

function recordId(result: ToolResult): string | undefined {
  if (result.status === 'found') {
    return undefined;
  }

  return result.record.id;
}

async function snapshotUpdate(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<CreatedRecord | undefined> {
  if (tool.name !== 'update_record' || !tool.input.id) {
    return undefined;
  }

  return client.getRecord({
    workspaceId,
    objectName: tool.input.objectName,
    id: tool.input.id,
  });
}

function effectsFor(
  tool: ValidatedTool,
  result: ToolResult,
  snapshot: CreatedRecord | undefined,
): ActEffect[] {
  if (result.status === 'created') {
    if (
      result.record.objectName === 'task' ||
      result.record.objectName === 'timelineActivity'
    ) {
      return [];
    }

    return [
      {
        kind: 'created',
        objectName: result.record.objectName,
        id: result.record.id,
        etag: result.record.etag,
      },
    ];
  }

  if (
    result.status === 'archived' &&
    tool.name === 'archive_record' &&
    tool.input.id
  ) {
    return [
      {
        kind: 'archived',
        objectName: tool.input.objectName,
        id: tool.input.id,
        etag: result.record.etag,
      },
    ];
  }

  if (
    result.status === 'updated' &&
    tool.name === 'update_record' &&
    tool.input.id
  ) {
    const field = tool.input.field;
    const previous =
      snapshot &&
      Object.prototype.hasOwnProperty.call(snapshot.properties, field)
        ? (snapshot.properties[field] ?? null)
        : null;

    return [
      {
        kind: 'updated',
        objectName: tool.input.objectName,
        id: tool.input.id,
        field,
        previous,
        written: tool.input.value,
        etag: result.record.etag,
      },
    ];
  }

  return [];
}

function withRollback(message: string, completedCount: number): string {
  if (completedCount === 0) {
    return message;
  }

  return `${message} ${completedCount} earlier change(s) were rolled back.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Twenty request failed';
}

function isRefusal(value: unknown): value is ActRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'refused' in value &&
    (value as { refused?: unknown }).refused === true
  );
}
