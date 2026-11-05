import {
  CrmNotFoundError,
  CrmPartialWriteError,
  CrmPreconditionError,
} from '../twenty/crm-errors';
import { UnsafeSearchQueryError } from '../twenty/safe-search';
import type { CreatedRecord, DeletableObjectName, TwentyCrmClient } from '../twenty/twenty-crm-client';
import { mapIntentToTool } from './map-intent';
import { parseGatewayRequest } from './parse-request';
import { preflightRefs, resolveRelationId } from './resolve-refs';
import {
  refusal,
  upstreamFailure,
  type ActPartialFailure,
  type ActRefusal,
  type ActResult,
  type ToolCall,
  type ToolResult,
} from './types';
import { validateTool, type ValidatedTool } from './validate-tool';

export type ExecuteActOptions = {
  boundWorkspaceId?: string;
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

  if (options.boundWorkspaceId && parsed.workspaceId !== options.boundWorkspaceId) {
    return refusal(
      'cross_workspace',
      `Request workspace "${parsed.workspaceId}" does not match the gateway workspace "${options.boundWorkspaceId}".`,
    );
  }

  const tools = resolveTools(parsed);

  if ('refused' in tools) {
    return tools;
  }

  const validated: ValidatedTool[] = [];

  for (const tool of tools) {
    const result = validateTool(tool, parsed.workspaceId);

    if ('refused' in result) {
      return result;
    }

    if (result.name === 'update_record' && !result.input.ifMatch) {
      return refusal(
        'missing_required_fields',
        'Refusing update_record: missing required fields: ifMatch.',
        { toolName: 'update_record', missingFields: ['ifMatch'] },
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
  const effects: CompletedEffect[] = [];

  try {
    for (const tool of validated) {
      const resolved = resolveTool(tool, priorIds);

      if ('refused' in resolved) {
        const remaining = await compensate(client, parsed.workspaceId, effects);
        if (remaining.length > 0) {
          return partialFailure(resolved.message, remaining);
        }
        return refusal(resolved.reason, withRollback(resolved.message, effects.length), {
          toolName: resolved.toolName,
          missingFields: resolved.missingFields,
        });
      }

      const snapshot = await snapshotUpdate(client, parsed.workspaceId, resolved);
      const result = await dispatch(client, parsed.workspaceId, resolved);
      results.push(result);
      priorIds.push(recordId(result));
      effects.push(...effectsFor(resolved, result, snapshot));
    }
  } catch (error) {
    const orphans =
      error instanceof CrmPartialWriteError ? error.remainingRecordIds : [];
    const remaining = [
      ...orphans,
      ...(await compensate(client, parsed.workspaceId, effects)),
    ];
    const message = errorMessage(error);

    if (remaining.length > 0 || error instanceof CrmPartialWriteError) {
      return partialFailure(message, remaining);
    }

    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', withRollback(message, effects.length), { toolName: 'update_record' });
    }

    if (error instanceof CrmPreconditionError) {
      return refusal('precondition_failed', withRollback(message, effects.length), {
        toolName: 'update_record',
      });
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

  return refusal('invalid_request', 'Provide a tools array or an intent string.');
}

function resolveTool(
  tool: ValidatedTool,
  priorIds: Array<string | undefined>,
): ValidatedTool | ActRefusal {
  if (tool.name === 'create_person' && tool.input.companyId) {
    const companyId = resolveRelationId(tool.input.companyId, priorIds, tool.name);

    if (typeof companyId !== 'string' && companyId !== undefined) {
      return companyId;
    }

    return {
      ...tool,
      input: { ...tool.input, ...(companyId ? { companyId } : {}) },
    };
  }

  if (tool.name === 'create_opportunity') {
    const companyId = resolveRelationId(tool.input.companyId, priorIds, tool.name);
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
    const targetId = resolveRelationId(tool.input.targetId, priorIds, tool.name);

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
      const record = await client.createOpportunity({ ...tool.input, workspaceId });
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
      const records = await client.searchRecords({ ...tool.input, workspaceId });
      return { tool: tool.name, status: 'found', records };
    }
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
  }
}

function recordId(result: ToolResult): string | undefined {
  if (result.status === 'found') {
    return undefined;
  }

  return result.record.id;
}

type CompletedEffect =
  | { kind: 'created'; objectName: DeletableObjectName; id: string }
  | {
      kind: 'updated';
      objectName: 'person' | 'company' | 'opportunity';
      id: string;
      field: string;
      previous: string | number | undefined;
      etag: string;
    };

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
): CompletedEffect[] {
  if (result.status === 'created') {
    return [{ kind: 'created', objectName: result.record.objectName, id: result.record.id }];
  }

  if (result.status === 'updated' && tool.name === 'update_record' && tool.input.id) {
    return [
      {
        kind: 'updated',
        objectName: tool.input.objectName,
        id: tool.input.id,
        field: tool.input.field,
        previous: snapshot?.properties[tool.input.field],
        etag: result.record.etag,
      },
    ];
  }

  return [];
}

async function compensate(
  client: TwentyCrmClient,
  workspaceId: string,
  effects: CompletedEffect[],
): Promise<string[]> {
  const remaining: string[] = [];

  for (const effect of [...effects].reverse()) {
    try {
      if (effect.kind === 'created') {
        await client.deleteRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
        });
        continue;
      }

      if (effect.previous === undefined) {
        remaining.push(effect.id);
        continue;
      }

      const current = await client.getRecord({
        workspaceId,
        objectName: effect.objectName,
        id: effect.id,
      });
      await client.updateRecord({
        workspaceId,
        objectName: effect.objectName,
        id: effect.id,
        field: effect.field,
        value: effect.previous,
        ifMatch: current.etag,
      });
    } catch {
      remaining.push(effect.id);
    }
  }

  return remaining;
}

function partialFailure(message: string, remainingRecordIds: string[]): ActPartialFailure {
  return {
    ok: false,
    refused: false,
    reason: 'partial_failure',
    message: `${message} Some earlier changes could not be rolled back.`,
    remainingRecordIds,
  };
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
