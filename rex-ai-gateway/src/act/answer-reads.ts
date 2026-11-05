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

  let settled: Array<{
    index: number;
    summary: string;
    records: PlanAnswerRecord[];
  }>;

  try {
    settled = await Promise.all(
      tools.map(async (tool, index) => {
        const found = await runRead(client, workspaceId, tool);
        const records = found.map(toAnswerRecord);
        const summary = describeTool(tool).summary.replace(/\.$/, '');
        onRead?.({ tool: tool.name, summary, records });

        return { index, summary, records };
      }),
    );
  } catch (error) {
    if (error instanceof UnsafeSearchQueryError) {
      return refusal('invalid_request', error.message, {
        toolName: 'search_records',
      });
    }

    return upstreamFailure(error, 0);
  }

  settled.sort((left, right) => left.index - right.index);
  const parts = settled.map((item) => item.summary);
  const records = settled.flatMap((item) => item.records);
  const summary =
    records.length === 0
      ? `${parts.join(' ')}. No matching records.`
      : `${parts.join(' ')}. ${records.length} match${records.length === 1 ? '' : 'es'}.`;

  return { summary, records };
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
