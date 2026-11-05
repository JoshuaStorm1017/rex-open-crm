import { CrmNotFoundError, CrmPreconditionError } from '../twenty/crm-errors';
import type { CreatedRecord, TwentyCrmClient } from '../twenty/twenty-crm-client';
import type { LlmProvider } from '../llm/llm-provider';
import { describeTool, summarizeLines } from './describe-tool';
import { parseGatewayRequest } from './parse-request';
import {
  refusal,
  upstreamFailure,
  type ActRefusal,
  type PlanProposal,
  type PlanResult,
  type ProposalLine,
  type ToolCall,
} from './types';
import { validateTool, type ValidatedTool } from './validate-tool';
import type { ExecuteActOptions } from './execute-act';

export async function proposeAct(
  body: unknown,
  client: TwentyCrmClient,
  llm: LlmProvider,
  options: ExecuteActOptions = {},
): Promise<PlanResult> {
  const parsed = parseGatewayRequest(body);

  if ('refused' in parsed) {
    return parsed;
  }

  const workspaceRefusal = rejectForeignWorkspace(parsed.workspaceId, options.boundWorkspaceId);

  if (workspaceRefusal) {
    return workspaceRefusal;
  }

  if (parsed.tools && parsed.tools.length > 0) {
    return previewTools(client, parsed.workspaceId, parsed.tools, parsed.intent);
  }

  if (parsed.intent === undefined || parsed.intent.trim().length === 0) {
    return refusal('invalid_request', 'Provide an intent string.');
  }

  let planned;

  try {
    planned = await llm.plan({
      intent: parsed.intent,
      workspaceId: parsed.workspaceId,
      client,
    });
  } catch (error) {
    return upstreamFailure(error, 0);
  }

  if (!planned.ok) {
    return planned;
  }

  return previewTools(client, parsed.workspaceId, planned.tools, planned.summary);
}

async function previewTools(
  client: TwentyCrmClient,
  workspaceId: string,
  tools: ToolCall[],
  summary: string | undefined,
): Promise<PlanResult> {
  const validated: ValidatedTool[] = [];

  for (const tool of tools) {
    const result = validateTool(tool, workspaceId);

    if ('refused' in result) {
      return result;
    }

    validated.push(result);
  }

  const lines: ProposalLine[] = [];
  const normalized: ToolCall[] = [];

  try {
    for (const tool of validated) {
      const current = await enrichUpdate(client, workspaceId, tool);

      if ('refused' in current) {
        return current;
      }

      lines.push(describeTool(tool, current.record));
      normalized.push(toolCallFromValidated(tool));
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

  const proposal: PlanProposal = {
    summary: summary && summary.trim().length > 0 ? summary.trim() : summarizeLines(lines),
    tools: normalized,
    lines,
  };

  return { ok: true, workspaceId, proposal };
}

async function enrichUpdate(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<{ record?: CreatedRecord } | ActRefusal> {
  if (tool.name !== 'update_record') {
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
