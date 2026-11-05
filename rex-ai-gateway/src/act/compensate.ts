import { CrmNotFoundError } from '../twenty/crm-errors';
import type { TwentyCrmClient, TwentyObjectName } from '../twenty/twenty-crm-client';
import { isUpdatableField } from './writable-fields';
import type { ActEffect, ActPartialFailure } from './types';

export type CompensateFailure = {
  index: number;
  id: string;
  reason: 'conflict' | 'error';
};

export async function compensate(
  client: TwentyCrmClient,
  workspaceId: string,
  effects: ActEffect[],
): Promise<CompensateFailure[]> {
  const remaining: CompensateFailure[] = [];
  const reversedInThisPass = new Set<string>();

  for (const { effect, index } of effects.map((effect, index) => ({ effect, index })).reverse()) {
    const key = `${effect.objectName}:${effect.id}`;

    try {
      if (effect.kind === 'archived') {
        await client.restoreRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
        });
        continue;
      }

      if (effect.kind === 'created') {
        if (effect.etag && !reversedInThisPass.has(key)) {
          const current = await readCreatedEtag(client, workspaceId, effect);

          if (current === 'missing') {
            continue;
          }

          if (current !== effect.etag) {
            remaining.push({ index, id: effect.id, reason: 'conflict' });
            continue;
          }
        }

        await client.deleteRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
        });
        continue;
      }

      if (!isUpdatableField(effect.objectName, effect.field)) {
        remaining.push({ index, id: effect.id, reason: 'conflict' });
        continue;
      }

      if (
        effect.previous !== null &&
        typeof effect.previous !== 'string' &&
        typeof effect.previous !== 'number'
      ) {
        remaining.push({ index, id: effect.id, reason: 'conflict' });
        continue;
      }

      const current = await client.getRecord({
        workspaceId,
        objectName: effect.objectName,
        id: effect.id,
      });

      // A later effect in this same undo already rewrote the row, so its etag moved.
      // Any other etag means the field may no longer hold the value this act wrote.
      if (!reversedInThisPass.has(key) && current.etag !== effect.etag) {
        remaining.push({ index, id: effect.id, reason: 'conflict' });
        continue;
      }

      reversedInThisPass.add(key);

      if (effect.previous === null) {
        await client.clearRecordField({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
          field: effect.field,
          ifMatch: current.etag,
        });
        continue;
      }

      await client.updateRecord({
        workspaceId,
        objectName: effect.objectName,
        id: effect.id,
        field: effect.field,
        value: effect.previous,
        ifMatch: current.etag,
      });
    } catch (error) {
      if (effect.kind === 'created' && error instanceof CrmNotFoundError) {
        continue;
      }

      remaining.push({ index, id: effect.id, reason: 'error' });
    }
  }

  return remaining;
}

async function readCreatedEtag(
  client: TwentyCrmClient,
  workspaceId: string,
  effect: Extract<ActEffect, { kind: 'created' }>,
): Promise<string | 'missing'> {
  try {
    if (effect.objectName === 'note') {
      const note = await client.getNote({ workspaceId, id: effect.id });
      return note.etag;
    }

    if (effect.objectName === 'noteTarget' || !isWorkspaceObject(effect.objectName)) {
      return effect.etag ?? 'missing';
    }

    const current = await client.getRecord({
      workspaceId,
      objectName: effect.objectName,
      id: effect.id,
    });

    return current.etag;
  } catch (error) {
    if (error instanceof CrmNotFoundError) {
      return 'missing';
    }

    throw error;
  }
}

function isWorkspaceObject(objectName: string): objectName is TwentyObjectName {
  return objectName === 'person' || objectName === 'company' || objectName === 'opportunity';
}

export function partialFailure(message: string, remainingRecordIds: string[]): ActPartialFailure {
  return {
    ok: false,
    refused: false,
    reason: 'partial_failure',
    message: `${message} Some earlier changes could not be rolled back.`,
    remainingRecordIds,
  };
}
