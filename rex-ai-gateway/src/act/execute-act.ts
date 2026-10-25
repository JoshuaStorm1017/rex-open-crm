import { isRecord } from '../is-record';
import type { TwentyCrmClient } from '../twenty/twenty-crm-client';
import { WORKSPACE_ID_PATTERN } from './find-foreign-workspace-id';
import { mapIntentToTool } from './map-intent';
import {
  refusal,
  type ActRefusal,
  type ActResult,
  type ActUpstreamFailure,
  type CreatedToolResult,
  type ToolCall,
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
  const parsed = parseRequest(body);

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

  const validated: ValidatedTool[] = [];

  for (const tool of tools) {
    const result = validateTool(tool, parsed.workspaceId);

    if ('refused' in result) {
      return result;
    }

    validated.push(result);
  }

  const results: CreatedToolResult[] = [];

  try {
    for (const tool of validated) {
      results.push(await dispatch(client, parsed.workspaceId, tool));
    }
  } catch (error) {
    return upstreamFailure(error, results.length);
  }

  return {
    ok: true,
    workspaceId: parsed.workspaceId,
    results,
  };
}

type ParsedRequest = {
  workspaceId: string;
  tools?: ToolCall[];
  intent?: string;
};

function parseRequest(body: unknown): ParsedRequest | ActRefusal {
  if (!isRecord(body)) {
    return refusal('invalid_request', 'Body must be a JSON object.');
  }

  if (typeof body.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(body.workspaceId)) {
    return refusal(
      'invalid_request',
      'workspaceId must be a gateway token such as "ws_demo".',
    );
  }

  let tools: ToolCall[] | undefined;

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return refusal('invalid_request', 'tools must be an array.');
    }

    tools = [];

    for (let index = 0; index < body.tools.length; index += 1) {
      const parsedTool = parseToolCall(body.tools[index], index);

      if ('refused' in parsedTool) {
        return parsedTool;
      }

      tools.push(parsedTool);
    }
  }

  if (body.intent !== undefined && typeof body.intent !== 'string') {
    return refusal('invalid_request', 'intent must be a string.');
  }

  return {
    workspaceId: body.workspaceId,
    ...(tools ? { tools } : {}),
    ...(typeof body.intent === 'string' ? { intent: body.intent } : {}),
  };
}

function parseToolCall(value: unknown, index: number): ToolCall | ActRefusal {
  if (!isRecord(value)) {
    return refusal('invalid_request', `tools[${index}] must be an object.`);
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return refusal('invalid_request', `tools[${index}].name must be a string.`);
  }

  if (!isRecord(value.args)) {
    return refusal('invalid_request', `tools[${index}].args must be an object.`, {
      toolName: value.name,
    });
  }

  return { name: value.name.trim(), args: value.args };
}

function resolveTools(request: ParsedRequest): ToolCall[] | ActRefusal {
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

async function dispatch(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<CreatedToolResult> {
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
  }
}

function upstreamFailure(
  error: unknown,
  createdCount: number,
): ActUpstreamFailure {
  const detail = error instanceof Error ? error.message : 'Twenty request failed';
  const message =
    createdCount > 0
      ? `Twenty request failed after ${createdCount} create(s) succeeded. ${detail}`
      : detail;

  return {
    ok: false,
    refused: false,
    reason: 'upstream_error',
    message: message.replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}
