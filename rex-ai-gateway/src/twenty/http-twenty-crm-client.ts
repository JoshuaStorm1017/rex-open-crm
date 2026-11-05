import {
  currentTwentyCredential,
  twentyAuthHeaders,
} from '../auth/call-context';
import { fetchWithPinnedDns } from '../http/pinned-fetch';
import { assertConnectableHost } from '../http/public-url';
import { isRecord } from '../is-record';
import {
  CrmNotFoundError,
  CrmPartialWriteError,
  CrmPreconditionError,
} from './crm-errors';
import {
  TWENTY_CREATE_TARGET,
  TWENTY_OBJECT_PATH,
  companyIdEqualsFilter,
  conditionalUpdateFilter,
  deleteManyName,
  restoreManyName,
  graphqlSearchFilter,
  graphqlTimelineRecordFilter,
  graphqlTimelineSearchFilter,
  RECORD_GRAPHQL_FIELDS,
  restSearchFilter,
  restTimelineRecordFilter,
  restTimelineSearchFilter,
  toClearPayload,
  toCompanyPayload,
  toOpportunityPayload,
  toPersonPayload,
  toUpdatePayload,
  updateManyName,
} from './map-to-twenty-payload';
import {
  CREATE_RELATION_FIELD_NAMES,
  FIELD_METADATA_NAMES,
} from './field-permission-names';
import {
  activityRecordFromTwenty,
  crmRecordFromTwenty,
  labelFromProperties,
  projectField,
  readEtag,
} from './record-fields';
import {
  UPDATABLE_FIELDS,
  isUpdatableObjectName,
} from '../act/writable-fields';
import {
  type CreateCompanyInput,
  type CreateNoteInput,
  type CreateOpportunityInput,
  type CreatePersonInput,
  type CreatedRecord,
  type DeletableObjectName,
  type DeleteRecordInput,
  type ArchiveRecordInput,
  type GetRecordInput,
  type ListRecentInput,
  type NoteLookupInput,
  type SearchRecordsInput,
  type SearchTimelineInput,
  type TimelineObjectName,
  type TwentyCrmClient,
  type TwentyObjectName,
  type ClearRecordFieldInput,
  type FieldCapability,
  type MemberCapabilities,
  type ObjectCapabilityName,
  type UpdateRecordInput,
  companyProperties,
  opportunityProperties,
  personProperties,
} from './twenty-crm-client';

export type TwentyApiStyle = 'rest' | 'graphql';

export type TwentyHttpClientConfig = {
  apiUrl: string;
  style?: TwentyApiStyle;
  fetchImpl?: typeof fetch;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RECORD_PATH_ID = /^[A-Za-z0-9_-]{1,80}$/;

const DELETE_TARGET: Record<
  DeletableObjectName,
  { restPath: string; mutationName: string }
> = {
  person: { restPath: '/rest/people', mutationName: 'deletePerson' },
  company: { restPath: '/rest/companies', mutationName: 'deleteCompany' },
  opportunity: {
    restPath: '/rest/opportunities',
    mutationName: 'deleteOpportunity',
  },
  note: { restPath: '/rest/notes', mutationName: 'deleteNote' },
  noteTarget: {
    restPath: '/rest/noteTargets',
    mutationName: 'deleteNoteTarget',
  },
};

export function readTwentyApiOrigin(apiUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('TWENTY_API_URL must be an http(s) origin.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('TWENTY_API_URL must not include credentials.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TWENTY_API_URL must be an http(s) origin.');
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      'TWENTY_API_URL must be an origin without a path, query, or hash.',
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error('TWENTY_API_URL may use http only for a loopback host.');
  }

  assertConnectableHost(hostname, 'TWENTY_API_URL', true);

  return parsed.origin;
}

type JsonResult = {
  status: number;
  body: unknown;
};

export function readHttpClientConfigFromEnv(
  env: NodeJS.ProcessEnv,
): TwentyHttpClientConfig | undefined {
  const apiUrl = env.TWENTY_API_URL?.trim() ?? '';

  if (apiUrl.length === 0) {
    if ((env.TWENTY_API_KEY?.trim() ?? '').length > 0) {
      throw new Error(
        'TWENTY_API_KEY is not used. Writes run as the signed-in member. Set TWENTY_API_URL, or neither variable to use the in-memory mock.',
      );
    }

    return undefined;
  }

  const style = env.TWENTY_API_STYLE?.trim() || 'rest';

  if (style !== 'rest' && style !== 'graphql') {
    throw new Error('TWENTY_API_STYLE must be "rest" or "graphql".');
  }

  return { apiUrl: readTwentyApiOrigin(apiUrl), style };
}

export function createHttpTwentyCrmClient(
  config: TwentyHttpClientConfig,
): TwentyCrmClient {
  const style = config.style ?? 'rest';
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiUrl = readTwentyApiOrigin(config.apiUrl);

  const requestJson = async (
    path: string,
    init: { method: string; body?: unknown; ifMatch?: string },
  ): Promise<JsonResult> => {
    const headers: Record<string, string> = {
      ...twentyAuthHeaders(currentTwentyCredential()),
      'content-type': 'application/json',
    };

    if (init.ifMatch) {
      headers['If-Match'] = init.ifMatch;
    }

    const response = await fetchWithPinnedDns(
      `${apiUrl}${path}`,
      {
        method: init.method,
        headers,
        redirect: 'error',
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      fetchImpl,
      'TWENTY_API_URL',
    );
    const text = await response.text();
    let body: unknown;

    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new Error(
        `Twenty ${style} request failed with ${response.status}.`,
      );
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new CrmNotFoundError(`Twenty ${style} request returned 404.`);
      }

      if (response.status === 412) {
        throw new CrmPreconditionError(
          `Twenty refused the update precondition (${response.status}).`,
          init.ifMatch ?? 'unknown',
        );
      }

      throw new Error(
        `Twenty ${style} request failed with ${response.status}.`,
      );
    }

    if (
      isRecord(body) &&
      Array.isArray(body.errors) &&
      body.errors.length > 0
    ) {
      throw new Error('Twenty GraphQL error.');
    }

    return { status: response.status, body };
  };

  const create = async (
    objectName: TwentyObjectName,
    payload: Record<string, unknown>,
    properties: Record<string, string | number>,
    workspaceId: string,
  ): Promise<CreatedRecord> => {
    const target = TWENTY_CREATE_TARGET[objectName];
    const path = style === 'rest' ? target.restPath : '/graphql';
    const body =
      style === 'rest'
        ? payload
        : {
            query: `mutation Create($data: ${target.inputType}!) { ${target.mutationName}(data: $data) { id updatedAt } }`,
            variables: { data: payload },
          };
    const result = await requestJson(path, { method: 'POST', body });
    const created = readMutationRecord(result.body, target.mutationName);

    return {
      id: readId(created, target.mutationName),
      objectName,
      workspaceId,
      properties,
      etag: readEtag(created),
      label: labelFromProperties(objectName, properties),
    };
  };

  const loadRecord = async (input: GetRecordInput): Promise<CreatedRecord> => {
    const target = TWENTY_OBJECT_PATH[input.objectName];
    const result =
      style === 'rest'
        ? await requestJson(
            `${target.restPath}/${recordPathId(input.id)}?depth=1`,
            {
              method: 'GET',
            },
          )
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `query Get($id: UUID!) { ${target.singular}(filter: { id: { eq: $id } }) { ${RECORD_GRAPHQL_FIELDS[input.objectName]} } }`,
              variables: { id: input.id },
            },
          });
    const raw = readDataRecord(
      result.body,
      style === 'rest' ? target.singular : target.singular,
    );
    const record = crmRecordFromTwenty(
      input.objectName,
      input.workspaceId,
      raw,
    );

    if (!record) {
      throw new CrmNotFoundError(
        `No ${input.objectName} found with id ${input.id}.`,
      );
    }

    return record;
  };

  const commitFieldWrite = async (
    input: ClearRecordFieldInput,
    current: CreatedRecord,
    data: Record<string, unknown>,
    nextProperties: Record<string, string | number>,
  ): Promise<CreatedRecord> => {
    if (current.etag !== input.ifMatch) {
      throw new CrmPreconditionError(
        `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${current.etag}.`,
        current.etag,
      );
    }

    const target = TWENTY_OBJECT_PATH[input.objectName];
    const manyName = updateManyName(input.objectName);
    let filter: string;

    try {
      filter = conditionalUpdateFilter(input.id, input.ifMatch);
    } catch {
      throw new CrmPreconditionError(
        `If-Match ${input.ifMatch} cannot be compared for ${input.objectName} ${input.id}.`,
        current.etag,
      );
    }

    // Twenty ignores If-Match. The etag is updatedAt, applied as a filter on update-many so a stale row matches nothing.
    const result =
      style === 'rest'
        ? await requestJson(
            `${target.restPath}?filter=${encodeURIComponent(filter)}`,
            {
              method: 'PATCH',
              body: data,
            },
          )
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `mutation Update($filter: ${target.filterInputType}!, $data: ${target.updateInputType}!) { ${manyName}(filter: $filter, data: $data) { id updatedAt } }`,
              variables: {
                filter: {
                  and: [
                    { id: { eq: input.id } },
                    { updatedAt: { eq: input.ifMatch } },
                  ],
                },
                data,
              },
            },
          });
    const updatedRows = readUpdatedList(result.body, manyName);

    if (updatedRows.length !== 1) {
      throw new CrmPreconditionError(
        `If-Match ${input.ifMatch} did not match the current ${input.objectName} row. Nothing was written.`,
        current.etag,
      );
    }

    const raw = updatedRows[0] ?? {};
    const updated = crmRecordFromTwenty(input.objectName, input.workspaceId, {
      ...nextProperties,
      id: input.id,
      ...(isRecord(raw) ? raw : {}),
    });

    if (!updated) {
      throw new Error(
        `Twenty response is missing ${target.updateMutationName}.id`,
      );
    }

    return {
      ...updated,
      properties: nextProperties,
      label: labelFromProperties(input.objectName, nextProperties),
    };
  };

  const deleteById = async (
    objectName: DeletableObjectName,
    id: string,
  ): Promise<void> => {
    const target = deleteTarget(objectName);

    if (style === 'rest') {
      // Without this flag Twenty destroys the row. Undo and archive both mean soft-delete.
      await requestJson(`${target.restPath}/${id}?soft_delete=true`, {
        method: 'DELETE',
      });
      return;
    }

    await requestJson('/graphql', {
      method: 'POST',
      body: {
        query: `mutation Delete($id: UUID!) { ${target.mutationName}(id: $id) { id } }`,
        variables: { id },
      },
    });
  };

  const readNoteEtag = async (id: string): Promise<string> => {
    const safeId = recordPathId(id);
    const result =
      style === 'rest'
        ? await requestJson(`/rest/notes/${safeId}`, { method: 'GET' })
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query:
                'query Get($id: UUID!) { note(filter: { id: { eq: $id } }) { id updatedAt title } }',
              variables: { id: safeId },
            },
          });
    const raw = readDataRecord(result.body, 'note');

    if (!isRecord(raw) || typeof raw.id !== 'string') {
      throw new CrmNotFoundError(`No note found with id ${id}.`);
    }

    return readEtag(raw);
  };

  const assertDeleteEtag = async (input: DeleteRecordInput): Promise<void> => {
    const ifMatch = input.ifMatch;

    if (!ifMatch) {
      return;
    }

    rejectEtagSentinel(ifMatch, input.objectName);

    if (input.objectName === 'note') {
      const currentEtag = await readNoteEtag(input.id);

      if (currentEtag !== ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${ifMatch} does not match the current note version ${currentEtag}. Nothing was deleted.`,
          currentEtag,
        );
      }

      return;
    }

    if (!isWorkspaceObject(input.objectName)) {
      return;
    }

    const current = await loadRecord({
      workspaceId: input.workspaceId,
      objectName: input.objectName,
      id: input.id,
    });

    if (current.etag !== ifMatch) {
      throw new CrmPreconditionError(
        `If-Match ${ifMatch} does not match the current ${input.objectName} version ${current.etag}. Nothing was deleted.`,
        current.etag,
      );
    }
  };

  const deleteWhereEtag = async (input: DeleteRecordInput): Promise<void> => {
    const ifMatch = input.ifMatch;

    if (!ifMatch) {
      return;
    }

    const target = conditionalDeleteTarget(input.objectName);
    let filter: string;

    try {
      filter = conditionalUpdateFilter(input.id, ifMatch);
    } catch {
      throw new CrmPreconditionError(
        `If-Match ${ifMatch} cannot be compared for ${input.objectName} ${input.id}. Nothing was deleted.`,
        ifMatch,
      );
    }

    // Twenty ignores If-Match. Soft-delete many with updatedAt[eq] so a row that moved matches nothing.
    const result =
      style === 'rest'
        ? await requestJson(
            `${target.restPath}?filter=${encodeURIComponent(filter)}&soft_delete=true`,
            { method: 'DELETE' },
          )
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `mutation Delete($filter: ${target.filterType}!) { ${target.manyName}(filter: $filter) { id } }`,
              variables: {
                filter: {
                  and: [
                    { id: { eq: input.id } },
                    { updatedAt: { eq: ifMatch } },
                  ],
                },
              },
            },
          });
    const deleted = readUpdatedList(result.body, target.manyName);

    if (deleted.length !== 1) {
      throw new CrmPreconditionError(
        `If-Match ${ifMatch} did not match the current ${input.objectName} row. Nothing was deleted.`,
        ifMatch,
      );
    }
  };

  const restoreWhereEtag = async (input: DeleteRecordInput): Promise<void> => {
    const ifMatch = input.ifMatch;

    if (!ifMatch || !isWorkspaceObject(input.objectName)) {
      throw new CrmPreconditionError(
        `Restore of ${input.objectName} requires If-Match. Nothing was restored.`,
        ifMatch ?? 'missing',
      );
    }

    const target = TWENTY_OBJECT_PATH[input.objectName];
    const manyName = restoreManyName(input.objectName);
    let filter: string;

    try {
      filter = conditionalUpdateFilter(input.id, ifMatch);
    } catch {
      throw new CrmPreconditionError(
        `If-Match ${ifMatch} cannot be compared for ${input.objectName} ${input.id}. Nothing was restored.`,
        ifMatch,
      );
    }

    // Restore-one has no filter. Restore-many matches id and the post-archive updatedAt, including trashed rows.
    const result =
      style === 'rest'
        ? await requestJson(
            `${target.restPath}/restore?filter=${encodeURIComponent(filter)}`,
            { method: 'PATCH' },
          )
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `mutation Restore($filter: ${target.filterInputType}!) { ${manyName}(filter: $filter) { id } }`,
              variables: {
                filter: {
                  and: [
                    { id: { eq: input.id } },
                    { updatedAt: { eq: ifMatch } },
                  ],
                },
              },
            },
          });
    const restored = readUpdatedList(result.body, manyName);

    if (restored.length !== 1) {
      throw new CrmPreconditionError(
        `If-Match ${ifMatch} did not match the archived ${input.objectName} row. Nothing was restored.`,
        ifMatch,
      );
    }
  };

  const deleteNoteTargets = async (noteId: string): Promise<void> => {
    let listed: unknown;

    try {
      const result =
        style === 'rest'
          ? await requestJson(
              `/rest/noteTargets?filter=${encodeURIComponent(`noteId[eq]:"${noteId}"`)}&limit=50`,
              { method: 'GET' },
            )
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query:
                  'query Targets($filter: NoteTargetFilterInput) { noteTargets(filter: $filter, first: 50) { edges { node { id } } } }',
                variables: { filter: { noteId: { eq: noteId } } },
              },
            });
      listed = result.body;
    } catch {
      // Undo still deletes the note when Twenty rejects the link query.
      return;
    }

    for (const target of readList(listed, 'noteTargets')) {
      if (!isRecord(target) || typeof target.id !== 'string') {
        continue;
      }

      await deleteById('noteTarget', recordPathId(target.id));
    }
  };

  const searchTimeline = async (
    objectName: TimelineObjectName,
    input: SearchTimelineInput,
  ): Promise<CreatedRecord[]> => {
    const target = TIMELINE_SEARCH[objectName];
    const restFilter = input.recordId
      ? restTimelineRecordFilter(target.kind, input.recordId)
      : restTimelineSearchFilter(target.kind, input.query);
    const graphqlFilter = input.recordId
      ? graphqlTimelineRecordFilter(target.kind, input.recordId)
      : graphqlTimelineSearchFilter(target.kind, input.query);
    const result =
      style === 'rest'
        ? await requestJson(
            `${target.restPath}?filter=${encodeURIComponent(restFilter)}&limit=${input.limit}`,
            { method: 'GET' },
          )
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `query Search($filter: ${target.filterType}, $first: Int) { ${target.plural}(filter: $filter, first: $first) { edges { node { ${target.fields} } } } }`,
              variables: {
                filter: graphqlFilter,
                first: input.limit,
              },
            },
          });

    return readList(result.body, target.plural)
      .map((item) =>
        activityRecordFromTwenty(objectName, input.workspaceId, item),
      )
      .filter((record): record is CreatedRecord => record !== undefined)
      .slice(0, input.limit);
  };

  return {
    createPerson: (input: CreatePersonInput) =>
      create(
        'person',
        toPersonPayload(input),
        personProperties(input),
        input.workspaceId,
      ),
    createCompany: (input: CreateCompanyInput) =>
      create(
        'company',
        toCompanyPayload(input),
        companyProperties(input),
        input.workspaceId,
      ),
    createOpportunity: (input: CreateOpportunityInput) =>
      create(
        'opportunity',
        toOpportunityPayload(input),
        opportunityProperties(input),
        input.workspaceId,
      ),
    async searchRecords(input: SearchRecordsInput) {
      const target = TWENTY_OBJECT_PATH[input.objectName];
      const restFilter = input.linkedCompanyId
        ? companyIdEqualsFilter(input.linkedCompanyId)
        : restSearchFilter(input.objectName, input.query);
      const graphqlFilter = input.linkedCompanyId
        ? { companyId: { eq: input.linkedCompanyId } }
        : graphqlSearchFilter(input.objectName, input.query);
      const result =
        style === 'rest'
          ? await requestJson(
              `${target.restPath}?filter=${encodeURIComponent(restFilter)}&limit=${input.limit}&depth=1`,
              { method: 'GET' },
            )
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query: `query Search($filter: ${target.filterInputType}, $first: Int) { ${target.plural}(filter: $filter, first: $first) { edges { node { ${RECORD_GRAPHQL_FIELDS[input.objectName]} } } } }`,
                variables: {
                  filter: graphqlFilter,
                  first: input.limit,
                },
              },
            });

      return readList(result.body, target.plural)
        .map((item) =>
          crmRecordFromTwenty(input.objectName, input.workspaceId, item),
        )
        .filter((record): record is CreatedRecord => record !== undefined)
        .slice(0, input.limit);
    },
    getRecord: (input: GetRecordInput) => loadRecord(input),
    searchNotes: (input) => searchTimeline('note', input),
    searchTasks: (input) => searchTimeline('task', input),
    searchActivities: (input) => searchTimeline('timelineActivity', input),
    async updateRecord(input: UpdateRecordInput) {
      rejectEtagSentinel(input.ifMatch, input.objectName);
      const current = await loadRecord(input);
      const nextProperties = projectField(
        current.properties,
        input.field,
        input.value,
      );

      return commitFieldWrite(
        input,
        current,
        toUpdatePayload(
          input.objectName,
          input.field,
          input.value,
          current.properties,
          current.composites,
        ),
        nextProperties,
      );
    },
    async clearRecordField(input: ClearRecordFieldInput) {
      rejectEtagSentinel(input.ifMatch, input.objectName);
      const current = await loadRecord(input);
      const nextProperties = projectField(
        current.properties,
        input.field,
        null,
      );

      return commitFieldWrite(
        input,
        current,
        toClearPayload(
          input.objectName,
          input.field,
          current.properties,
          current.composites,
        ),
        nextProperties,
      );
    },
    async loadCapabilities(): Promise<MemberCapabilities> {
      const result = await requestJson('/metadata', {
        method: 'POST',
        body: {
          query: `query RexAiCapabilities {
            objects(paging: { first: 200 }) { edges { node { id nameSingular fieldsList { id name } } } }
            currentUser { currentUserWorkspace { objectPermissions { objectMetadataId canReadObjectRecords canUpdateObjectRecords canSoftDeleteObjectRecords restrictedFields } } }
          }`,
        },
      });
      return readCapabilities(result.body);
    },
    async createNote(input: CreateNoteInput) {
      if (!input.targetId) {
        throw new Error('create_note is missing targetId.');
      }

      const notePayload = {
        title: input.title ?? 'Note',
        bodyV2: { markdown: input.body },
      };
      const noteResult =
        style === 'rest'
          ? await requestJson('/rest/notes', {
              method: 'POST',
              body: notePayload,
            })
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query:
                  'mutation Create($data: NoteCreateInput!) { createNote(data: $data) { id updatedAt } }',
                variables: { data: notePayload },
              },
            });
      const created = readMutationRecord(noteResult.body, 'createNote');
      const noteId = readId(created, 'createNote');
      const targetKey =
        input.targetObject === 'person'
          ? 'targetPersonId'
          : input.targetObject === 'company'
            ? 'targetCompanyId'
            : 'targetOpportunityId';
      const targetPayload = { noteId, [targetKey]: input.targetId };

      try {
        if (style === 'rest') {
          await requestJson('/rest/noteTargets', {
            method: 'POST',
            body: targetPayload,
          });
        } else {
          await requestJson('/graphql', {
            method: 'POST',
            body: {
              query:
                'mutation Create($data: NoteTargetCreateInput!) { createNoteTarget(data: $data) { id } }',
              variables: { data: targetPayload },
            },
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Linking the note failed.';
        const safeNoteId = RECORD_PATH_ID.test(noteId) ? noteId : undefined;

        try {
          if (!safeNoteId) {
            throw new Error(
              'Refusing to place an unsafe note id in a Twenty URL.',
            );
          }

          if (style === 'rest') {
            await requestJson(`/rest/notes/${safeNoteId}?soft_delete=true`, {
              method: 'DELETE',
            });
          } else {
            await requestJson('/graphql', {
              method: 'POST',
              body: {
                query:
                  'mutation Delete($id: UUID!) { deleteNote(id: $id) { id } }',
                variables: { id: safeNoteId },
              },
            });
          }
        } catch {
          throw new CrmPartialWriteError(
            `${message} The note could not be deleted.`,
            safeNoteId ? [safeNoteId] : [],
          );
        }

        throw error;
      }

      return {
        id: noteId,
        objectName: 'note',
        workspaceId: input.workspaceId,
        properties: {
          title: input.title ?? 'Note',
          body: input.body,
          targetObject: input.targetObject,
          targetId: input.targetId,
        },
        etag: readEtag(created),
        label: input.title ?? 'Note',
      };
    },
    async listRecent(input: ListRecentInput) {
      const target = TWENTY_OBJECT_PATH[input.objectName];
      const limit = Math.min(Math.max(input.limit, 1), 5);
      const result =
        style === 'rest'
          ? await requestJson(
              `${target.restPath}?limit=${limit}&depth=1&order_by=${encodeURIComponent('updatedAt[DescNullsLast]')}`,
              { method: 'GET' },
            )
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query: `query Recent($first: Int) { ${target.plural}(first: $first, orderBy: [{ updatedAt: DescNullsLast }]) { edges { node { ${RECORD_GRAPHQL_FIELDS[input.objectName]} } } } }`,
                variables: { first: limit },
              },
            });

      return readList(result.body, target.plural)
        .map((item) =>
          crmRecordFromTwenty(input.objectName, input.workspaceId, item),
        )
        .filter((record): record is CreatedRecord => record !== undefined)
        .slice(0, limit);
    },
    async getNote(input: NoteLookupInput) {
      const result =
        style === 'rest'
          ? await requestJson(`/rest/notes/${recordPathId(input.id)}`, {
              method: 'GET',
            })
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query:
                  'query Get($id: UUID!) { note(filter: { id: { eq: $id } }) { id updatedAt title } }',
                variables: { id: input.id },
              },
            });
      const raw = readDataRecord(result.body, 'note');

      if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
        throw new CrmNotFoundError(`No note found with id ${input.id}.`);
      }

      const title =
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : 'Note';

      return {
        id: raw.id,
        objectName: 'note',
        workspaceId: input.workspaceId,
        properties: { title },
        etag: readEtag(raw),
        label: title,
      };
    },
    async archiveRecord(input: ArchiveRecordInput) {
      rejectEtagSentinel(input.ifMatch, input.objectName);
      const current = await loadRecord(input);

      if (current.etag !== input.ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${current.etag}.`,
          current.etag,
        );
      }

      const target = TWENTY_OBJECT_PATH[input.objectName];
      const manyName = deleteManyName(input.objectName);
      let filter: string;

      try {
        filter = conditionalUpdateFilter(input.id, input.ifMatch);
      } catch {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} cannot be compared for ${input.objectName} ${input.id}.`,
          current.etag,
        );
      }

      // Twenty ignores If-Match. Soft-delete many with updatedAt[eq] so a stale row matches nothing.
      const result =
        style === 'rest'
          ? await requestJson(
              `${target.restPath}?filter=${encodeURIComponent(filter)}&soft_delete=true`,
              { method: 'DELETE' },
            )
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query: `mutation Delete($filter: ${target.filterInputType}!) { ${manyName}(filter: $filter) { id updatedAt } }`,
                variables: {
                  filter: {
                    and: [
                      { id: { eq: input.id } },
                      { updatedAt: { eq: input.ifMatch } },
                    ],
                  },
                },
              },
            });
      const deleted = readUpdatedList(result.body, manyName);

      if (deleted.length !== 1) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} did not match the current ${input.objectName} row. Nothing was archived.`,
          current.etag,
        );
      }

      const archivedEtag = readEtag(deleted[0]);

      return {
        ...current,
        etag: archivedEtag === 'unversioned' ? current.etag : archivedEtag,
      };
    },
    async restoreRecord(input: DeleteRecordInput) {
      if (!isWorkspaceObject(input.objectName) || !input.ifMatch) {
        throw new CrmPreconditionError(
          `Restore of ${input.objectName} requires If-Match. Nothing was restored.`,
          input.ifMatch ?? 'missing',
        );
      }

      rejectEtagSentinel(input.ifMatch, input.objectName);

      try {
        const current = await loadRecord({
          workspaceId: input.workspaceId,
          objectName: input.objectName,
          id: input.id,
        });

        if (current.etag !== input.ifMatch) {
          throw new CrmPreconditionError(
            `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${current.etag}. Nothing was restored.`,
            current.etag,
          );
        }

        // Already live at this etag. Restore would bump updatedAt, so the row is left alone.
        return;
      } catch (error) {
        if (!(error instanceof CrmNotFoundError)) {
          throw error;
        }
      }

      await restoreWhereEtag(input);
    },
    async deleteRecord(input: DeleteRecordInput) {
      const id = recordPathId(input.id);

      if (input.ifMatch) {
        await assertDeleteEtag(input);
        await deleteWhereEtag(input);

        if (input.objectName === 'note') {
          // Targets follow the conditional note delete so a stale If-Match removes nothing.
          await deleteNoteTargets(id);
        }

        return;
      }

      if (input.objectName === 'note') {
        await deleteNoteTargets(id);
      }

      await deleteById(input.objectName, id);
    },
  };
}

function recordPathId(id: string): string {
  if (!RECORD_PATH_ID.test(id)) {
    throw new Error('Refusing to place an unsafe record id in a Twenty URL.');
  }

  return id;
}

function isWorkspaceObject(objectName: string): objectName is TwentyObjectName {
  return (
    objectName === 'person' ||
    objectName === 'company' ||
    objectName === 'opportunity'
  );
}

function conditionalDeleteTarget(objectName: DeletableObjectName): {
  restPath: string;
  manyName: string;
  filterType: string;
} {
  if (objectName === 'note') {
    return {
      restPath: '/rest/notes',
      manyName: 'deleteNotes',
      filterType: 'NoteFilterInput',
    };
  }

  if (objectName === 'noteTarget') {
    return {
      restPath: '/rest/noteTargets',
      manyName: 'deleteNoteTargets',
      filterType: 'NoteTargetFilterInput',
    };
  }

  const target = TWENTY_OBJECT_PATH[objectName];

  return {
    restPath: target.restPath,
    manyName: deleteManyName(objectName),
    filterType: target.filterInputType,
  };
}

function deleteTarget(objectName: string): {
  restPath: string;
  mutationName: string;
} {
  if (!Object.prototype.hasOwnProperty.call(DELETE_TARGET, objectName)) {
    throw new Error('Refusing to delete an unknown Twenty object.');
  }

  return DELETE_TARGET[objectName as DeletableObjectName];
}

function readMutationRecord(
  body: unknown,
  mutationName: string,
): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error(`Twenty response is missing data.${mutationName}.id`);
  }

  const record = body.data[mutationName];

  if (!isRecord(record)) {
    throw new Error(`Twenty response is missing data.${mutationName}.id`);
  }

  return record;
}

function readId(record: Record<string, unknown>, mutationName: string): string {
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`Twenty response is missing data.${mutationName}.id`);
  }

  return record.id;
}

function readDataRecord(body: unknown, key: string): unknown {
  if (!isRecord(body) || !isRecord(body.data)) {
    return undefined;
  }

  return body.data[key];
}

function readUpdatedList(
  body: unknown,
  key: string,
): Record<string, unknown>[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }

  const value = body.data[key];

  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readList(body: unknown, plural: string): unknown[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }

  const value = body.data[plural];

  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.edges)) {
    return value.edges.map((edge) => (isRecord(edge) ? edge.node : undefined));
  }

  return [];
}

const CAPABILITY_NAMES = new Set<ObjectCapabilityName>([
  'person',
  'company',
  'opportunity',
  'note',
  'task',
  'timelineActivity',
]);

const TIMELINE_SEARCH = {
  note: {
    restPath: '/rest/notes',
    plural: 'notes',
    filterType: 'NoteFilterInput',
    fields: 'id updatedAt title bodyV2 { markdown }',
    kind: 'note',
  },
  task: {
    restPath: '/rest/tasks',
    plural: 'tasks',
    filterType: 'TaskFilterInput',
    fields: 'id updatedAt title bodyV2 { markdown }',
    kind: 'task',
  },
  timelineActivity: {
    restPath: '/rest/timelineActivities',
    plural: 'timelineActivities',
    filterType: 'TimelineActivityFilterInput',
    fields: 'id updatedAt linkedRecordCachedName',
    kind: 'activity',
  },
} as const satisfies Record<
  TimelineObjectName,
  {
    restPath: string;
    plural: string;
    filterType: string;
    fields: string;
    kind: 'note' | 'task' | 'activity';
  }
>;

function rejectEtagSentinel(ifMatch: string, objectName: string): void {
  if (ifMatch === 'chained' || ifMatch === 'created') {
    throw new CrmPreconditionError(
      `If-Match ${ifMatch} is not a live ${objectName} etag. Refresh it from the previous write before calling Twenty.`,
      ifMatch,
    );
  }
}

function readCapabilities(body: unknown): MemberCapabilities {
  if (!isRecord(body) || !isRecord(body.data)) {
    return { unavailable: true, objects: [] };
  }

  const objectsConnection = body.data.objects;
  const currentUser = body.data.currentUser;

  if (
    !isRecord(objectsConnection) ||
    !Array.isArray(objectsConnection.edges) ||
    !isRecord(currentUser) ||
    !isRecord(currentUser.currentUserWorkspace) ||
    !Array.isArray(currentUser.currentUserWorkspace.objectPermissions)
  ) {
    return { unavailable: true, objects: [] };
  }

  const names = new Map<string, ObjectCapabilityName>();
  const fieldsByObject = new Map<string, Map<string, string>>();

  for (const edge of objectsConnection.edges) {
    if (!isRecord(edge) || !isRecord(edge.node)) {
      continue;
    }

    const { id, nameSingular, fieldsList } = edge.node;

    if (
      typeof id === 'string' &&
      typeof nameSingular === 'string' &&
      CAPABILITY_NAMES.has(nameSingular as ObjectCapabilityName)
    ) {
      names.set(id, nameSingular as ObjectCapabilityName);
      const metadataIds = metadataIdsByName(fieldsList);

      if (metadataIds) {
        fieldsByObject.set(id, metadataIds);
      }
    }
  }

  const objects: MemberCapabilities['objects'] = [];

  for (const permission of currentUser.currentUserWorkspace.objectPermissions) {
    if (
      !isRecord(permission) ||
      typeof permission.objectMetadataId !== 'string'
    ) {
      continue;
    }

    const objectName = names.get(permission.objectMetadataId);

    if (!objectName) {
      continue;
    }

    objects.push({
      objectName,
      canRead: permission.canReadObjectRecords === true,
      canUpdate: permission.canUpdateObjectRecords === true,
      canCreate: permission.canUpdateObjectRecords === true,
      canSoftDelete: permission.canSoftDeleteObjectRecords === true,
      ...fieldPermissionsFor(
        objectName,
        fieldsByObject.get(permission.objectMetadataId),
        permission.restrictedFields,
      ),
    });
  }

  return { objects };
}

function metadataIdsByName(
  fieldsList: unknown,
): Map<string, string> | undefined {
  if (!Array.isArray(fieldsList)) {
    return undefined;
  }

  const names = new Map<string, string>();

  for (const field of fieldsList) {
    if (
      !isRecord(field) ||
      typeof field.id !== 'string' ||
      typeof field.name !== 'string'
    ) {
      continue;
    }

    names.set(field.name, field.id);
  }

  return names;
}

function fieldPermissionsFor(
  objectName: ObjectCapabilityName,
  metadataIds: Map<string, string> | undefined,
  restrictedFields: unknown,
): { fieldPermissions: 'unavailable' | FieldCapability[] } {
  if (!isUpdatableObjectName(objectName)) {
    return { fieldPermissions: [] };
  }

  if (!metadataIds || !isRecord(restrictedFields)) {
    return { fieldPermissions: 'unavailable' };
  }

  const fields: FieldCapability[] = [];

  for (const fieldName of [
    ...UPDATABLE_FIELDS[objectName],
    ...CREATE_RELATION_FIELD_NAMES[objectName],
  ]) {
    const metadataNames = FIELD_METADATA_NAMES[objectName][fieldName] ?? [
      fieldName,
    ];
    let canUpdate = true;
    let unreadable = false;

    for (const metadataName of metadataNames) {
      const fieldId = metadataIds.get(metadataName);

      if (!fieldId) {
        unreadable = true;
        break;
      }

      const permission = restrictedFields[fieldId];

      if (!isRecord(permission)) {
        continue;
      }

      if (permission.canUpdate === false || permission.canRead === false) {
        canUpdate = false;
      }
    }

    fields.push(
      unreadable
        ? { name: fieldName, canUpdate: false, unreadable: true }
        : { name: fieldName, canUpdate },
    );
  }

  return { fieldPermissions: fields };
}
