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
  const archived = new Set<string>();

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

    if (!record || archived.has(record.id)) {
      throw new CrmNotFoundError(`No ${objectName} found with id ${id}.`);
    }

    return record;
  };

  const visible = (record: CreatedRecord): boolean => !archived.has(record.id);

  const searchStored = (
    workspaceId: string,
    objectName: CreatedRecord['objectName'],
    query: string,
    limit: number,
  ): CreatedRecord[] => {
    const needle = query.toLowerCase();

    return created
      .filter((record) => {
        if (!visible(record) || record.workspaceId !== workspaceId || record.objectName !== objectName) {
          return false;
        }

        const haystack = [record.label, ...Object.values(record.properties).map(String)].join(' ').toLowerCase();

        return haystack.includes(needle);
      })
      .slice(0, limit)
      .map(cloneRecord);
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
      return searchStored(input.workspaceId, input.objectName, input.query, input.limit);
    },
    async searchNotes(input) {
      return searchStored(input.workspaceId, 'note', input.query, input.limit);
    },
    async searchTasks(input) {
      return searchStored(input.workspaceId, 'task', input.query, input.limit);
    },
    async searchActivities(input) {
      return searchStored(input.workspaceId, 'timelineActivity', input.query, input.limit);
    },
    async listRecent(input) {
      return created
        .filter(
          (record) =>
            visible(record) &&
            record.workspaceId === input.workspaceId &&
            record.objectName === input.objectName,
        )
        .slice(-input.limit)
        .reverse()
        .map(cloneRecord);
    },
    async getNote(input) {
      const record = created.find(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.objectName === 'note' &&
          candidate.id === input.id &&
          !archived.has(candidate.id),
      );

      if (!record) {
        throw new CrmNotFoundError(`No note found with id ${input.id}.`);
      }

      return cloneRecord(record);
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
    async clearRecordField(input) {
      const record = findStored(input.workspaceId, input.objectName, input.id);

      if (record.etag !== input.ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${record.etag}.`,
          record.etag,
        );
      }

      applyField(record, input.field, null);
      record.etag = nextVersionEtag(record.etag);
      return cloneRecord(record);
    },
    async archiveRecord(input) {
      const record = findStored(input.workspaceId, input.objectName, input.id);

      if (record.etag !== input.ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${record.etag}.`,
          record.etag,
        );
      }

      archived.add(record.id);
      record.etag = nextVersionEtag(record.etag);
      return cloneRecord(record);
    },
    async restoreRecord(input) {
      const record = created.find(
        (candidate) => candidate.workspaceId === input.workspaceId && candidate.id === input.id,
      );

      if (!record || !archived.has(record.id)) {
        throw new CrmNotFoundError(`No ${input.objectName} found with id ${input.id}.`);
      }

      archived.delete(record.id);
      record.etag = nextVersionEtag(record.etag);
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
