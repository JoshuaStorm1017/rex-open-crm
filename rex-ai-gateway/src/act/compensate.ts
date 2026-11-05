import { CrmNotFoundError, CrmPreconditionError } from '../twenty/crm-errors';
import type {
  TwentyCrmClient,
  TwentyObjectName,
} from '../twenty/twenty-crm-client';
import { isUpdatableField } from './writable-fields';
import type { ActEffect, ActPartialFailure } from './types';

export type CompensateFailure = {
  index: number;
  id: string;
  reason: 'conflict' | 'error' | 'superseded';
};

export async function compensate(
  client: TwentyCrmClient,
  workspaceId: string,
  effects: ActEffect[],
  shouldContinue: () => boolean = () => true,
): Promise<CompensateFailure[]> {
  const remaining: CompensateFailure[] = [];
  const reversedInThisPass = new Set<string>();
  let halt = false;

  for (const { effect, index } of effects
    .map((effect, index) => ({ effect, index }))
    .reverse()) {
    const key = `${effect.objectName}:${effect.id}`;

    try {
      if (halt || !shouldContinue()) {
        halt = true;
        remaining.push({ index, id: effect.id, reason: 'superseded' });
        continue;
      }

      if (effect.kind === 'archived') {
        if (!shouldContinue()) {
          halt = true;
          remaining.push({ index, id: effect.id, reason: 'superseded' });
          continue;
        }

        await client.restoreRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
          ifMatch: effect.etag,
        });

        if (!shouldContinue()) {
          halt = true;
        }

        continue;
      }

      if (effect.kind === 'created') {
        if (effect.etag && !reversedInThisPass.has(key)) {
          const current = await readCreatedEtag(client, workspaceId, effect);

          // The etag read yields. A newer act saved in that gap must not be followed by a delete.
          if (!shouldContinue()) {
            remaining.push({ index, id: effect.id, reason: 'superseded' });
            continue;
          }

          if (current === 'missing') {
            continue;
          }

          if (current !== effect.etag) {
            remaining.push({ index, id: effect.id, reason: 'conflict' });
            continue;
          }
        }

        if (!shouldContinue()) {
          halt = true;
          remaining.push({ index, id: effect.id, reason: 'superseded' });
          continue;
        }

        await client.deleteRecord({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
          ...(effect.etag ? { ifMatch: effect.etag } : {}),
        });

        if (!shouldContinue()) {
          halt = true;
        }

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

      if (!shouldContinue()) {
        remaining.push({ index, id: effect.id, reason: 'superseded' });
        continue;
      }

      const currentValue = fieldValue(current.properties, effect.field);

      // The loser of a stolen undo may already have written this value back.
      // Dropping it lets the winner finish the other effects and clear the ticket.
      if (valuesEqual(currentValue, effect.previous)) {
        continue;
      }

      // A later effect in this same undo already rewrote the row, so its etag moved.
      // Any other etag means the field may no longer hold the value this act wrote.
      if (!reversedInThisPass.has(key) && current.etag !== effect.etag) {
        // A newer undo on this row moves the etag while leaving this act's value in place.
        if (effect.written === undefined || currentValue !== effect.written) {
          remaining.push({ index, id: effect.id, reason: 'conflict' });
          continue;
        }
      }

      reversedInThisPass.add(key);

      if (!shouldContinue()) {
        halt = true;
        remaining.push({ index, id: effect.id, reason: 'superseded' });
        continue;
      }

      if (effect.previous === null) {
        await client.clearRecordField({
          workspaceId,
          objectName: effect.objectName,
          id: effect.id,
          field: effect.field,
          ifMatch: current.etag,
        });

        if (!shouldContinue()) {
          halt = true;
        }

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

      if (!shouldContinue()) {
        halt = true;
      }
    } catch (error) {
      if (effect.kind === 'created' && error instanceof CrmNotFoundError) {
        continue;
      }

      if (error instanceof CrmPreconditionError) {
        remaining.push({ index, id: effect.id, reason: 'conflict' });
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

    if (
      effect.objectName === 'noteTarget' ||
      !isWorkspaceObject(effect.objectName)
    ) {
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

function fieldValue(
  properties: Record<string, string | number>,
  field: string,
): string | number | null {
  if (!Object.prototype.hasOwnProperty.call(properties, field)) {
    return null;
  }

  const value = properties[field];

  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }

  return null;
}

function valuesEqual(
  current: string | number | null,
  previous: string | number | null,
): boolean {
  return current === previous;
}

function isWorkspaceObject(objectName: string): objectName is TwentyObjectName {
  return (
    objectName === 'person' ||
    objectName === 'company' ||
    objectName === 'opportunity'
  );
}

export function partialFailure(
  message: string,
  remainingRecordIds: string[],
): ActPartialFailure {
  return {
    ok: false,
    refused: false,
    reason: 'partial_failure',
    message: `${message} Some earlier changes could not be rolled back.`,
    remainingRecordIds,
  };
}
