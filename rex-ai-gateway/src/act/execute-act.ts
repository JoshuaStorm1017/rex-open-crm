import { CrmNotFoundError, CrmPreconditionError } from '../twenty/crm-errors';
import type { CreatedRecord, TwentyCrmClient } from '../twenty/twenty-crm-client';
import { mapIntentToTool } from './map-intent';
import { parseGatewayRequest } from './parse-request';
import { preflightRefs, resolveRelationId } from './resolve-refs';
import {
  refusal,
  upstreamFailure,
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

  try {
    for (const tool of validated) {
      const resolved = resolveTool(tool, priorIds);

      if ('refused' in resolved) {
        return resolved;
      }

      const result = await dispatch(client, parsed.workspaceId, resolved);
      results.push(result);
      priorIds.push(recordId(result));
    }
  } catch (error) {
    if (error instanceof CrmNotFoundError) {
      return refusal('not_found', error.message, { toolName: 'update_record' });
    }

    if (error instanceof CrmPreconditionError) {
      return refusal('precondition_failed', withCompleted(error.message, results.length), {
        toolName: 'update_record',
      });
    }

    return upstreamFailure(error, results.length);
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
        id: tool.input.id,
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

function withCompleted(message: string, completedCount: number): string {
  if (completedCount === 0) {
    return message;
  }

  return `${message} ${completedCount} earlier tool(s) already succeeded.`;
}

function isRefusal(value: unknown): value is ActRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'refused' in value &&
    (value as { refused?: unknown }).refused === true
  );
}
