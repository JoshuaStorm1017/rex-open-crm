import type { CreatedRecord } from '../twenty/twenty-crm-client';

export const ALLOWED_TOOL_NAMES = [
  'create_person',
  'create_company',
  'create_opportunity',
  'search_records',
  'update_record',
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

export const MAX_TOOLS_PER_REQUEST = 8;

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type RefusalReason =
  | 'invalid_request'
  | 'unknown_tool'
  | 'missing_required_fields'
  | 'cross_workspace'
  | 'unmapped_intent'
  | 'unsafe_intent'
  | 'ambiguous_intent'
  | 'not_found'
  | 'precondition_failed'
  | 'unauthorized'
  | 'idempotency_conflict'
  | 'confirmation_required';

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
  tool: 'create_person' | 'create_company' | 'create_opportunity';
  status: 'created';
  record: CreatedRecord;
};

export type SearchToolResult = {
  tool: 'search_records';
  status: 'found';
  records: CreatedRecord[];
};

export type UpdatedToolResult = {
  tool: 'update_record';
  status: 'updated';
  record: CreatedRecord;
};

export type ToolResult = CreatedToolResult | SearchToolResult | UpdatedToolResult;

export type ActSuccess = {
  ok: true;
  workspaceId: string;
  results: ToolResult[];
};

export type ActResult = ActSuccess | ActRefusal | ActUpstreamFailure;

export type ProposalLine = {
  tool: AllowedToolName;
  summary: string;
};

export type PlanProposal = {
  id: string;
  summary: string;
  tools: ToolCall[];
  lines: ProposalLine[];
};

export type PlanSuccess = {
  ok: true;
  workspaceId: string;
  proposal: PlanProposal;
};

export type PlanResult = PlanSuccess | ActRefusal | ActUpstreamFailure;

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

export function upstreamFailure(error: unknown, completedCount: number): ActUpstreamFailure {
  const detail = error instanceof Error ? error.message : 'Twenty request failed';
  const message =
    completedCount > 0
      ? `Twenty request failed after ${completedCount} tool(s) succeeded. ${detail}`
      : detail;

  return {
    ok: false,
    refused: false,
    reason: 'upstream_error',
    message: message.replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}
