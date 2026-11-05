import { CrmNotFoundError } from '../twenty/crm-errors';
import type {
  TwentyCrmClient,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import { displayChange } from './preview-changes';
import {
  refusal,
  upstreamFailure,
  type ActRefusal,
  type ActUpstreamFailure,
  type ProposalChange,
  type ToolCall,
} from './types';

export type LiveEtagCheck =
  | { ok: true }
  | { ok: false; failure: ActRefusal | ActUpstreamFailure };

type ComparableWrite = {
  objectName: TwentyObjectName;
  id: string;
  ifMatch: string;
  field?: string;
  proposed: string | number | null;
};

export async function findStaleChanges(
  client: TwentyCrmClient,
  workspaceId: string,
  tools: ToolCall[],
): Promise<LiveEtagCheck> {
  const stale: ProposalChange[] = [];

  try {
    for (const tool of tools) {
      const target = readComparable(tool);

      if (!target) {
        continue;
      }

      let record;

      try {
        record = await client.getRecord({
          workspaceId,
          objectName: target.objectName,
          id: target.id,
        });
      } catch (error) {
        if (error instanceof CrmNotFoundError) {
          stale.push(
            displayChange({
              objectName: target.objectName,
              recordId: target.id,
              label: target.id,
              ...(target.field ? { field: target.field } : {}),
              current: null,
              proposed: target.proposed,
              ifMatch: target.ifMatch,
            }),
          );
          continue;
        }

        throw error;
      }

      if (record.etag === target.ifMatch) {
        continue;
      }

      const raw = target.field ? record.properties[target.field] : record.label;
      const current =
        typeof raw === 'string' || typeof raw === 'number' ? raw : null;

      stale.push(
        displayChange({
          objectName: target.objectName,
          recordId: target.id,
          label: record.label,
          ...(target.field ? { field: target.field } : {}),
          current,
          proposed: target.proposed,
          ifMatch: target.ifMatch,
        }),
      );
    }
  } catch (error) {
    return { ok: false, failure: upstreamFailure(error, 0) };
  }

  if (stale.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    failure: refusal('precondition_failed', staleMessage(stale), { stale }),
  };
}

function staleMessage(changes: ProposalChange[]): string {
  const first = changes[0];

  if (!first) {
    return 'The record changed. Confirm is blocked.';
  }

  const extra = changes.length > 1 ? ` ${changes.length} records moved.` : '';

  return `${first.summary} Confirm is blocked.${extra}`;
}

function readComparable(tool: ToolCall): ComparableWrite | undefined {
  if (tool.name !== 'update_record' && tool.name !== 'archive_record') {
    return undefined;
  }

  const objectName = tool.args.object;
  const id = tool.args.id;
  const ifMatch = tool.args.ifMatch;

  if (
    !isObjectName(objectName) ||
    typeof id !== 'string' ||
    !isLiveEtag(ifMatch)
  ) {
    return undefined;
  }

  if (tool.name === 'archive_record') {
    return { objectName, id, ifMatch, proposed: null };
  }

  const field = tool.args.field;
  const value = tool.args.value;

  if (
    typeof field !== 'string' ||
    (typeof value !== 'string' && typeof value !== 'number')
  ) {
    return undefined;
  }

  return { objectName, id, ifMatch, field, proposed: value };
}

function isLiveEtag(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== 'chained' &&
    value !== 'created' &&
    !value.startsWith('$')
  );
}

function isObjectName(value: unknown): value is TwentyObjectName {
  return value === 'person' || value === 'company' || value === 'opportunity';
}
