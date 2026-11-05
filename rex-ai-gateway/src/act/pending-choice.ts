import type { ToolCall } from './types';

export type ChoiceCandidate = {
  id: string;
  label: string;
  detail?: string;
  etag: string;
};

export type PendingChoice = {
  kind: 'update' | 'note' | 'archive';
  objectName: 'person' | 'company' | 'opportunity';
  field: string;
  value: string | number;
  title?: string;
  body: string;
  query?: string;
  candidates: ChoiceCandidate[];
  createTools?: ToolCall[];
};

export type ChoiceGroup = {
  id: string;
  kind: 'update' | 'note' | 'archive';
  objectName: 'person' | 'company' | 'opportunity';
  query: string;
  updates: Array<{ field: string; value: string | number }>;
  title?: string;
  body: string;
  candidates: ChoiceCandidate[];
  createTools?: ToolCall[];
};

export type PendingBatchStep =
  | { type: 'tool'; tool: ToolCall }
  | { type: 'choice'; groupId: string; updateIndex: number };

export type PendingBatch = {
  kind: 'batch';
  groups: ChoiceGroup[];
  steps: PendingBatchStep[];
};

export type PendingSelection = PendingChoice | PendingBatch;

export function isPendingBatch(value: PendingSelection): value is PendingBatch {
  return value.kind === 'batch';
}
