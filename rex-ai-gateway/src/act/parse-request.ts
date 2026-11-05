import { isRecord } from '../is-record';
import { WORKSPACE_ID_PATTERN } from './find-foreign-workspace-id';
import {
  MAX_TOOLS_PER_REQUEST,
  refusal,
  type ActRefusal,
  type ToolCall,
} from './types';

export type ParsedRequest = {
  workspaceId: string;
  tools?: ToolCall[];
  intent?: string;
  confirmed: boolean;
};

const MAX_INTENT_CHARS = 500;

export function parseGatewayRequest(body: unknown): ParsedRequest | ActRefusal {
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

    if (body.tools.length > MAX_TOOLS_PER_REQUEST) {
      return refusal(
        'invalid_request',
        `A request can include at most ${MAX_TOOLS_PER_REQUEST} tools.`,
      );
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

  if (typeof body.intent === 'string' && body.intent.trim().length > MAX_INTENT_CHARS) {
    return refusal(
      'invalid_request',
      `intent must be at most ${MAX_INTENT_CHARS} characters.`,
    );
  }

  if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
    return refusal('invalid_request', 'confirmed must be a boolean.');
  }

  return {
    workspaceId: body.workspaceId,
    ...(tools ? { tools } : {}),
    ...(typeof body.intent === 'string' ? { intent: body.intent } : {}),
    confirmed: body.confirmed === true,
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
