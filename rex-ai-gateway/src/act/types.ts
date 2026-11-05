import type { SkillParameterPrompt } from './skill-parameters';
import type { CreatedRecord } from '../twenty/twenty-crm-client';

export const ALLOWED_TOOL_NAMES = [
  'create_person',
  'create_company',
  'create_opportunity',
  'create_note',
  'search_records',
  'search_notes',
  'search_tasks',
  'search_activities',
  'update_record',
  'update_matching_records',
  'archive_record',
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
  | 'forbidden'
  | 'idempotency_conflict'
  | 'confirmation_required';

export type ProposalChange = {
  objectName: 'person' | 'company' | 'opportunity';
  recordId: string;
  label: string;
  field?: string;
  metadataField?: string;
  current: string | number | null;
  proposed: string | number | null;
  ifMatch: string;
  summary: string;
};

export type ProposalCompanyLink = {
  companyId: string;
  label: string;
};

export type ProposalWarning = {
  code:
    | 'duplicate_email'
    | 'duplicate_name'
    | 'duplicate_domain'
    | 'amount_mismatch';
  message: string;
  link?: ProposalCompanyLink;
};

export const PROPOSAL_CREATE_FIELDS = [
  'name',
  'email',
  'domain',
  'amount',
  'stage',
] as const;

export type ProposalCreateField = (typeof PROPOSAL_CREATE_FIELDS)[number];

export type ProposalCreateCell = {
  field: ProposalCreateField;
  value: string;
};

export type ProposalCreate = {
  objectName: 'person' | 'company' | 'opportunity';
  label: string;
  summary: string;
  cells: ProposalCreateCell[];
};

export type PlanAnswerRecord = {
  id: string;
  objectName: string;
  label: string;
  detail?: string;
};

export type FailedRead = {
  tool: string;
  message: string;
  retry: {
    name: string;
    args: Record<string, unknown>;
  };
};

export type PlanAnswer = {
  summary: string;
  records: PlanAnswerRecord[];
  failedReads?: FailedRead[];
};

export type ReadEvent = {
  tool: string;
  summary: string;
  records: PlanAnswerRecord[];
  failed?: boolean;
  message?: string;
  retry?: FailedRead['retry'];
};

export type CaptureReview = {
  text: string;
  cardCount: number;
};

export type ActRefusal = {
  ok: false;
  refused: true;
  reason: RefusalReason;
  message: string;
  toolName?: string;
  missingFields?: string[];
  stale?: ProposalChange[];
};

export type ActUpstreamFailure = {
  ok: false;
  refused: false;
  reason: 'upstream_error';
  message: string;
};

export type ActPartialFailure = {
  ok: false;
  refused: false;
  reason: 'partial_failure';
  message: string;
  remainingRecordIds: string[];
};

export type CreatedToolResult = {
  tool:
    | 'create_person'
    | 'create_company'
    | 'create_opportunity'
    | 'create_note';
  status: 'created';
  record: CreatedRecord;
};

export type SearchToolResult = {
  tool:
    | 'search_records'
    | 'search_notes'
    | 'search_tasks'
    | 'search_activities';
  status: 'found';
  records: CreatedRecord[];
};

export type UpdatedToolResult = {
  tool: 'update_record';
  status: 'updated';
  record: CreatedRecord;
};

export type ArchivedToolResult = {
  tool: 'archive_record';
  status: 'archived';
  record: CreatedRecord;
};

export type ToolResult =
  | CreatedToolResult
  | SearchToolResult
  | UpdatedToolResult
  | ArchivedToolResult;

export type ActEffect =
  | {
      kind: 'created';
      objectName: 'person' | 'company' | 'opportunity' | 'note' | 'noteTarget';
      id: string;
      etag?: string;
    }
  | {
      kind: 'updated';
      objectName: 'person' | 'company' | 'opportunity';
      id: string;
      field: string;
      previous: string | number | null;
      written?: string | number;
      etag: string;
    }
  | {
      kind: 'archived';
      objectName: 'person' | 'company' | 'opportunity';
      id: string;
      etag: string;
    };

export type ActUndo = {
  id: string;
  summary: string;
};

export type ActSuccess = {
  ok: true;
  workspaceId: string;
  results: ToolResult[];
  effects?: ActEffect[];
  undo?: ActUndo;
  undos?: ActUndo[];
  reversesAuditId?: string;
  summary?: string;
};

export type ActResult =
  | ActSuccess
  | ActRefusal
  | ActUpstreamFailure
  | ActPartialFailure;

export type ProposalLine = {
  tool: AllowedToolName;
  summary: string;
};

export type PlanChoiceCandidate = {
  id: string;
  label: string;
  objectName: 'person' | 'company' | 'opportunity';
  action: 'use' | 'create';
  detail?: string;
};

export type PlanChoiceGroup = {
  id: string;
  prompt: string;
  candidates: PlanChoiceCandidate[];
};

export type PlanChoice = {
  prompt: string;
  candidates: PlanChoiceCandidate[];
  groups?: PlanChoiceGroup[];
};

export type PlanProposal = {
  id: string;
  summary: string;
  tools: ToolCall[];
  lines: ProposalLine[];
  choice?: PlanChoice;
  changes?: ProposalChange[];
  warnings?: ProposalWarning[];
  creates?: ProposalCreate[];
};

export type PlanSuccess = {
  ok: true;
  workspaceId: string;
  summary?: string;
  proposal?: PlanProposal;
  answer?: PlanAnswer;
  parameters?: SkillParameterPrompt[];
  captureReview?: CaptureReview;
};

export type PlanResult = PlanSuccess | ActRefusal | ActUpstreamFailure;

export function refusal(
  reason: RefusalReason,
  message: string,
  extra?: {
    toolName?: string;
    missingFields?: string[];
    stale?: ProposalChange[];
  },
): ActRefusal {
  return {
    ok: false,
    refused: true,
    reason,
    message,
    ...(extra?.toolName ? { toolName: extra.toolName } : {}),
    ...(extra?.missingFields ? { missingFields: extra.missingFields } : {}),
    ...(extra?.stale && extra.stale.length > 0 ? { stale: extra.stale } : {}),
  };
}

export function upstreamFailure(
  error: unknown,
  completedCount: number,
): ActUpstreamFailure {
  const detail =
    error instanceof Error ? error.message : 'Twenty request failed';
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
