import { UnsafeSearchQueryError } from '../twenty/safe-search';
import type {
  CreatedRecord,
  TwentyCrmClient,
} from '../twenty/twenty-crm-client';
import { describeTool } from './describe-tool';
import {
  refusal,
  upstreamFailure,
  type ActRefusal,
  type ActUpstreamFailure,
  type FailedRead,
  type PlanAnswer,
  type PlanAnswerRecord,
  type ReadEvent,
} from './types';
import type { ValidatedTool } from './validate-tool';

export function isReadTool(tool: ValidatedTool): boolean {
  return (
    tool.name === 'search_records' ||
    tool.name === 'search_notes' ||
    tool.name === 'search_tasks' ||
    tool.name === 'search_activities'
  );
}

type SettledRead = {
  index: number;
  summary: string;
  records: PlanAnswerRecord[];
  failed?: FailedRead;
  unsafe?: boolean;
};

export async function answerReads(
  client: TwentyCrmClient,
  workspaceId: string,
  tools: ValidatedTool[],
  onRead?: (event: ReadEvent) => void,
): Promise<PlanAnswer | ActRefusal | ActUpstreamFailure> {
  for (const tool of tools) {
    if (!isReadTool(tool)) {
      return refusal(
        'invalid_request',
        'A write cannot be answered without Confirm.',
        { toolName: tool.name },
      );
    }
  }

  const settled = await Promise.all(
    tools.map(async (tool, index) =>
      settleRead(client, workspaceId, tool, index, onRead),
    ),
  );

  const succeeded = settled.filter((item) => !item.failed);

  if (succeeded.length === 0) {
    const first = settled[0];

    if (first && settled.every((item) => item.unsafe)) {
      return refusal(
        'invalid_request',
        first.failed?.message ?? 'That search was refused.',
        {
          toolName: first.failed?.tool,
        },
      );
    }

    return upstreamFailure(
      new Error(first?.failed?.message ?? 'That search failed.'),
      0,
    );
  }

  settled.sort((left, right) => left.index - right.index);
  const records = settled.flatMap((item) => item.records);
  const failedReads = settled.flatMap((item) =>
    item.failed ? [item.failed] : [],
  );
  const parts = settled.map((item) =>
    item.failed ? `${item.summary} failed` : item.summary,
  );
  const matchLabel = `${records.length} match${records.length === 1 ? '' : 'es'}`;
  const summary =
    records.length === 0
      ? `${parts.join('. ')}. No matching records.`
      : `${parts.join('. ')}. ${matchLabel}.`;

  return {
    summary,
    records,
    ...(failedReads.length > 0 ? { failedReads } : {}),
  };
}

async function settleRead(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
  index: number,
  onRead?: (event: ReadEvent) => void,
): Promise<SettledRead> {
  const summary = describeTool(tool).summary.replace(/\.$/, '');

  try {
    const found = await runRead(client, workspaceId, tool);
    const records = found.map(toAnswerRecord);
    onRead?.({ tool: tool.name, summary, records });

    return { index, summary, records };
  } catch (error) {
    const unsafe = error instanceof UnsafeSearchQueryError;
    const message = unsafe
      ? error.message
      : searchFailureMessage(tool.name, error);
    const retry = retryCall(tool);
    const failed: FailedRead = { tool: tool.name, message, retry };
    onRead?.({
      tool: tool.name,
      summary,
      records: [],
      failed: true,
      message,
      retry,
    });

    return {
      index,
      summary,
      records: [],
      failed,
      ...(unsafe ? { unsafe: true } : {}),
    };
  }
}

function searchFailureMessage(toolName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : 'That search failed.';
  const clean = detail.replace(/\s+/g, ' ').trim().slice(0, 180);

  return `${labelFor(toolName)} search failed. ${clean}`;
}

function labelFor(toolName: string): string {
  if (toolName === 'search_notes') {
    return 'Notes';
  }

  if (toolName === 'search_tasks') {
    return 'Tasks';
  }

  if (toolName === 'search_activities') {
    return 'Activities';
  }

  return 'Record';
}

function retryCall(tool: ValidatedTool): FailedRead['retry'] {
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

  if (
    tool.name === 'search_notes' ||
    tool.name === 'search_tasks' ||
    tool.name === 'search_activities'
  ) {
    return {
      name: tool.name,
      args: {
        query: tool.input.query,
        limit: tool.input.limit,
        ...(tool.input.recordId ? { recordRef: 'open' } : {}),
      },
    };
  }

  return { name: tool.name, args: {} };
}

async function runRead(
  client: TwentyCrmClient,
  workspaceId: string,
  tool: ValidatedTool,
): Promise<CreatedRecord[]> {
  switch (tool.name) {
    case 'search_records':
      return client.searchRecords({ ...tool.input, workspaceId });
    case 'search_notes':
      return client.searchNotes({
        workspaceId,
        query: tool.input.query,
        limit: tool.input.limit,
        ...(tool.input.recordId ? { recordId: tool.input.recordId } : {}),
      });
    case 'search_tasks':
      return client.searchTasks({
        workspaceId,
        query: tool.input.query,
        limit: tool.input.limit,
        ...(tool.input.recordId ? { recordId: tool.input.recordId } : {}),
      });
    case 'search_activities':
      return client.searchActivities({
        workspaceId,
        query: tool.input.query,
        limit: tool.input.limit,
        ...(tool.input.recordId ? { recordId: tool.input.recordId } : {}),
      });
    default:
      return [];
  }
}

function toAnswerRecord(record: CreatedRecord): PlanAnswerRecord {
  const body = record.properties.body;
  const email = record.properties.email;
  const detail =
    typeof body === 'string'
      ? body
      : typeof email === 'string'
        ? email
        : undefined;

  return {
    id: record.id,
    objectName: record.objectName,
    label: record.label,
    ...(detail ? { detail } : {}),
  };
}
