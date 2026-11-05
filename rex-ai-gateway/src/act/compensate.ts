import { CrmNotFoundError } from '../twenty/crm-errors';
import type { TwentyCrmClient, TwentyObjectName } from '../twenty/twenty-crm-client';
import { isUpdatableField } from './writable-fields';
import type { ActEffect, ActPartialFailure } from './types';

export type CompensateFailure = {
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

  for (const effect of [...effects].reverse()) {
    const key = `${effect.objectName}:${effect.id}`;

    try {
      if (effect.kind === 'created') {
        if (
          effect.etag &&
          isWorkspaceObject(effect.objectName) &&
          !reversedInThisPass.has(key)
        ) {
          const current = await client.getRecord({
            workspaceId,
            objectName: effect.objectName,
            id: effect.id,
          });

          if (current.etag !== effect.etag) {
            remaining.push({ id: effect.id, reason: 'conflict' });
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
        remaining.push({ id: effect.id, reason: 'conflict' });
        continue;
      }

      if (
        effect.previous !== null &&
        typeof effect.previous !== 'string' &&
        typeof effect.previous !== 'number'
      ) {
        remaining.push({ id: effect.id, reason: 'conflict' });
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
        remaining.push({ id: effect.id, reason: 'conflict' });
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

      remaining.push({ id: effect.id, reason: 'error' });
    }
  }

  return remaining;
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
