import { randomUUID } from 'node:crypto';

import { CrmNotFoundError, CrmPreconditionError } from './crm-errors';
import {
  applyField,
  cloneRecord,
  labelFromProperties,
  nextVersionEtag,
} from './record-fields';
import {
  type CreatedRecord,
  type TwentyCrmClient,
  type TwentyObjectName,
  companyProperties,
  opportunityProperties,
  personProperties,
} from './twenty-crm-client';

export type MockTwentyCrmClient = TwentyCrmClient & {
  created: CreatedRecord[];
};

const INITIAL_ETAG = 'v1';

export function createMockTwentyCrmClient(): MockTwentyCrmClient {
  const created: CreatedRecord[] = [];

  const remember = (
    objectName: CreatedRecord['objectName'],
    workspaceId: string,
    properties: Record<string, string | number>,
    idPrefix: string,
  ): CreatedRecord => {
    const record: CreatedRecord = {
      id: `${idPrefix}_${randomUUID()}`,
      objectName,
      workspaceId,
      properties,
      etag: INITIAL_ETAG,
      label: labelFromProperties(objectName, properties),
    };
    created.push(record);
    return cloneRecord(record);
  };

  const findStored = (
    workspaceId: string,
    objectName: TwentyObjectName,
    id: string,
  ): CreatedRecord => {
    const record = created.find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.objectName === objectName &&
        candidate.id === id,
    );

    if (!record) {
      throw new CrmNotFoundError(`No ${objectName} found with id ${id}.`);
    }

    return record;
  };

  return {
    created,
    async createPerson(input) {
      return remember('person', input.workspaceId, personProperties(input), 'person');
    },
    async createCompany(input) {
      return remember('company', input.workspaceId, companyProperties(input), 'company');
    },
    async createOpportunity(input) {
      return remember(
        'opportunity',
        input.workspaceId,
        opportunityProperties(input),
        'opportunity',
      );
    },
    async createNote(input) {
      if (!input.targetId) {
        throw new Error('create_note is missing targetId.');
      }

      const note = remember(
        'note',
        input.workspaceId,
        {
          title: input.title ?? 'Note',
          body: input.body,
          targetObject: input.targetObject,
          targetId: input.targetId,
        },
        'note',
      );
      remember('note', input.workspaceId, { noteId: note.id }, 'noteTarget');
      return note;
    },
    async searchRecords(input) {
      const needle = input.query.toLowerCase();

      return created
        .filter((record) => {
          if (record.workspaceId !== input.workspaceId || record.objectName !== input.objectName) {
            return false;
          }

          const haystack = [record.label, ...Object.values(record.properties).map(String)]
            .join(' ')
            .toLowerCase();

          return haystack.includes(needle);
        })
        .slice(0, input.limit)
        .map(cloneRecord);
    },
    async getRecord(input) {
      return cloneRecord(findStored(input.workspaceId, input.objectName, input.id));
    },
    async updateRecord(input) {
      const record = findStored(input.workspaceId, input.objectName, input.id);

      if (record.etag !== input.ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${record.etag}.`,
          record.etag,
        );
      }

      applyField(record, input.field, input.value);
      record.etag = nextVersionEtag(record.etag);
      return cloneRecord(record);
    },
    async deleteRecord(input) {
      const index = created.findIndex(
        (record) => record.workspaceId === input.workspaceId && record.id === input.id,
      );

      if (index < 0) {
        throw new CrmNotFoundError(`No ${input.objectName} found with id ${input.id}.`);
      }

      const [removed] = created.splice(index, 1);

      if (removed) {
        for (let cursor = created.length - 1; cursor >= 0; cursor -= 1) {
          if (created[cursor]?.properties.noteId === removed.id) {
            created.splice(cursor, 1);
          }
        }
      }
    },
  };
}
