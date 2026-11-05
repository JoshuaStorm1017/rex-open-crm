import type { ToolCall } from './types';

export type PendingChoice = {
  kind: 'update' | 'note' | 'archive';
  objectName: 'person' | 'company' | 'opportunity';
  field: string;
  value: string | number;
  title?: string;
  body: string;
  query?: string;
  candidates: Array<{
    id: string;
    label: string;
    detail?: string;
    etag: string;
  }>;
  createTools?: ToolCall[];
};
