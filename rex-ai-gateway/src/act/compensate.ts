import type { TwentyCrmClient } from '../twenty/twenty-crm-client';
import type { ActEffect, ActPartialFailure } from './types';

export async function compensate(
  client: TwentyCrmClient,
  workspaceId: string,
  effects: ActEffect[],
): Promise<string[]> {
  const remaining: string[] = [];

  for (const effect of [...effects].reverse()) {
    try {
      if (effect.kind === 'created') {
        await client.deleteRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
        });
        continue;
      }

      const current = await client.getRecord({
        workspaceId,
        objectName: effect.objectName,
        id: effect.id,
      });

      // A missing property is the previous value. Clearing it is the reverse of the write.
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
    } catch {
      remaining.push(effect.id);
    }
  }

  return remaining;
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
