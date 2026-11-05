import { currentTwentyCredential, twentyAuthHeaders } from '../auth/call-context';
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
  conditionalUpdateFilter,
  graphqlSearchFilter,
  restSearchFilter,
  toClearPayload,
  toCompanyPayload,
  toOpportunityPayload,
  toPersonPayload,
  toUpdatePayload,
  updateManyName,
} from './map-to-twenty-payload';
import { crmRecordFromTwenty, labelFromProperties, readEtag } from './record-fields';
import {
  type CreateCompanyInput,
  type CreateNoteInput,
  type CreateOpportunityInput,
  type CreatePersonInput,
  type CreatedRecord,
  type DeletableObjectName,
  type DeleteRecordInput,
  type GetRecordInput,
  type SearchRecordsInput,
  type TwentyCrmClient,
  type TwentyObjectName,
  type ClearRecordFieldInput,
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

const DELETE_TARGET: Record<DeletableObjectName, { restPath: string; mutationName: string }> = {
  person: { restPath: '/rest/people', mutationName: 'deletePerson' },
  company: { restPath: '/rest/companies', mutationName: 'deleteCompany' },
  opportunity: { restPath: '/rest/opportunities', mutationName: 'deleteOpportunity' },
  note: { restPath: '/rest/notes', mutationName: 'deleteNote' },
  noteTarget: { restPath: '/rest/noteTargets', mutationName: 'deleteNoteTarget' },
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
    throw new Error('TWENTY_API_URL must be an origin without a path, query, or hash.');
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
      throw new Error(`Twenty ${style} request failed with ${response.status}.`);
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

      throw new Error(`Twenty ${style} request failed with ${response.status}.`);
    }

    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
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
        ? await requestJson(`${target.restPath}/${recordPathId(input.id)}?depth=1`, {
            method: 'GET',
          })
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `query Get($id: UUID!) { ${target.singular}(filter: { id: { eq: $id } }) { id updatedAt name stage jobTitle companyId pointOfContactId closeDate emails { primaryEmail } domainName { primaryLinkUrl } amount { amountMicros currencyCode } } }`,
              variables: { id: input.id },
            },
          });
    const raw = readDataRecord(result.body, style === 'rest' ? target.singular : target.singular);
    const record = crmRecordFromTwenty(input.objectName, input.workspaceId, raw);

    if (!record) {
      throw new CrmNotFoundError(`No ${input.objectName} found with id ${input.id}.`);
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
        ? await requestJson(`${target.restPath}?filter=${encodeURIComponent(filter)}`, {
            method: 'PATCH',
            body: data,
          })
        : await requestJson('/graphql', {
            method: 'POST',
            body: {
              query: `mutation Update($filter: ${target.filterInputType}!, $data: ${target.updateInputType}!) { ${manyName}(filter: $filter, data: $data) { id updatedAt } }`,
              variables: {
                filter: {
                  and: [{ id: { eq: input.id } }, { updatedAt: { eq: input.ifMatch } }],
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
      throw new Error(`Twenty response is missing ${target.updateMutationName}.id`);
    }

    return {
      ...updated,
      properties: nextProperties,
      label: labelFromProperties(input.objectName, nextProperties),
    };
  };

  const deleteById = async (objectName: DeletableObjectName, id: string): Promise<void> => {
    const target = deleteTarget(objectName);

    if (style === 'rest') {
      await requestJson(`${target.restPath}/${id}`, { method: 'DELETE' });
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

  return {
    createPerson: (input: CreatePersonInput) =>
      create('person', toPersonPayload(input), personProperties(input), input.workspaceId),
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
      const result =
        style === 'rest'
          ? await requestJson(
              `${target.restPath}?filter=${encodeURIComponent(restSearchFilter(input.objectName, input.query))}&limit=${input.limit}&depth=1`,
              { method: 'GET' },
            )
          : await requestJson('/graphql', {
              method: 'POST',
              body: {
                query: `query Search($filter: ${target.filterInputType}, $first: Int) { ${target.plural}(filter: $filter, first: $first) { edges { node { id updatedAt name stage jobTitle companyId pointOfContactId closeDate emails { primaryEmail } domainName { primaryLinkUrl } amount { amountMicros currencyCode } } } } }`,
                variables: {
                  filter: graphqlSearchFilter(input.objectName, input.query),
                  first: input.limit,
                },
              },
            });

      return readList(result.body, target.plural)
        .map((item) => crmRecordFromTwenty(input.objectName, input.workspaceId, item))
        .filter((record): record is CreatedRecord => record !== undefined)
        .slice(0, input.limit);
    },
    getRecord: (input: GetRecordInput) => loadRecord(input),
    async updateRecord(input: UpdateRecordInput) {
      const current = await loadRecord(input);
      const nextProperties = { ...current.properties, [input.field]: input.value };

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
      const current = await loadRecord(input);
      const nextProperties = { ...current.properties };
      delete nextProperties[input.field];

      return commitFieldWrite(
        input,
        current,
        toClearPayload(input.objectName, input.field, current.properties, current.composites),
        nextProperties,
      );
    },
    async loadCapabilities(): Promise<MemberCapabilities> {
      const result = await requestJson('/metadata', {
        method: 'POST',
        body: {
          query: `query RexAiCapabilities {
            objects(paging: { first: 200 }) { edges { node { id nameSingular } } }
            currentUser { currentUserWorkspace { objectPermissions { objectMetadataId canReadObjectRecords canUpdateObjectRecords canSoftDeleteObjectRecords } } }
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
          ? await requestJson('/rest/notes', { method: 'POST', body: notePayload })
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
          await requestJson('/rest/noteTargets', { method: 'POST', body: targetPayload });
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
        const message = error instanceof Error ? error.message : 'Linking the note failed.';
        const safeNoteId = RECORD_PATH_ID.test(noteId) ? noteId : undefined;

        try {
          if (!safeNoteId) {
            throw new Error('Refusing to place an unsafe note id in a Twenty URL.');
          }

          if (style === 'rest') {
            await requestJson(`/rest/notes/${safeNoteId}`, { method: 'DELETE' });
          } else {
            await requestJson('/graphql', {
              method: 'POST',
              body: {
                query: 'mutation Delete($id: UUID!) { deleteNote(id: $id) { id } }',
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
    async deleteRecord(input: DeleteRecordInput) {
      const id = recordPathId(input.id);

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

function deleteTarget(objectName: string): { restPath: string; mutationName: string } {
  if (!Object.prototype.hasOwnProperty.call(DELETE_TARGET, objectName)) {
    throw new Error('Refusing to delete an unknown Twenty object.');
  }

  return DELETE_TARGET[objectName as DeletableObjectName];
}

function readMutationRecord(body: unknown, mutationName: string): Record<string, unknown> {
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

function readUpdatedList(body: unknown, key: string): Record<string, unknown>[] {
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
]);

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

  for (const edge of objectsConnection.edges) {
    if (!isRecord(edge) || !isRecord(edge.node)) {
      continue;
    }

    const { id, nameSingular } = edge.node;

    if (
      typeof id === 'string' &&
      typeof nameSingular === 'string' &&
      CAPABILITY_NAMES.has(nameSingular as ObjectCapabilityName)
    ) {
      names.set(id, nameSingular as ObjectCapabilityName);
    }
  }

  const objects: MemberCapabilities['objects'] = [];

  for (const permission of currentUser.currentUserWorkspace.objectPermissions) {
    if (!isRecord(permission) || typeof permission.objectMetadataId !== 'string') {
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
      canSoftDelete: permission.canSoftDeleteObjectRecords === true,
    });
  }

  return { objects };
}

