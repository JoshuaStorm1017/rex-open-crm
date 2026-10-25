import type { CreatedRecord } from '../twenty/twenty-crm-client';

export const ALLOWED_TOOL_NAMES = [
  'create_person',
  'create_company',
  'create_opportunity',
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type RefusalReason =
  | 'invalid_request'
  | 'unknown_tool'
  | 'missing_required_fields'
  | 'cross_workspace'
  | 'unmapped_intent';

export type ActRefusal = {
  ok: false;
  refused: true;
  reason: RefusalReason;
  message: string;
  toolName?: string;
  missingFields?: string[];
};

export type ActUpstreamFailure = {
  ok: false;
  refused: false;
  reason: 'upstream_error';
  message: string;
};

export type CreatedToolResult = {
  tool: AllowedToolName;
  status: 'created';
  record: CreatedRecord;
};

export type ActSuccess = {
  ok: true;
  workspaceId: string;
  results: CreatedToolResult[];
};

export type ActResult = ActSuccess | ActRefusal | ActUpstreamFailure;

export function refusal(
  reason: RefusalReason,
  message: string,
  extra?: { toolName?: string; missingFields?: string[] },
): ActRefusal {
  return {
    ok: false,
    refused: true,
    reason,
    message,
    ...(extra?.toolName ? { toolName: extra.toolName } : {}),
    ...(extra?.missingFields ? { missingFields: extra.missingFields } : {}),
  };
}
