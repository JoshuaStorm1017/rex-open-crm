import { currentTwentyCredential, twentyAuthHeaders } from '../auth/call-context';
import { isRecord } from '../is-record';
import { CrmNotFoundError, CrmPreconditionError } from './crm-errors';
import {
  TWENTY_CREATE_TARGET,
  TWENTY_OBJECT_PATH,
  conditionalUpdateFilter,
  graphqlSearchFilter,
  restSearchFilter,
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
  type DeleteRecordInput,
  type GetRecordInput,
  type SearchRecordsInput,
  type TwentyCrmClient,
  type TwentyObjectName,
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

  return { apiUrl, style };
}

export function createHttpTwentyCrmClient(
  config: TwentyHttpClientConfig,
): TwentyCrmClient {
  const style = config.style ?? 'rest';
  const fetchImpl = config.fetchImpl ?? fetch;
  const apiUrl = config.apiUrl.replace(/\/+$/, '');

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

    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: init.method,
      headers,
      redirect: 'error',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
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
        ? await requestJson(`${target.restPath}/${input.id}?depth=1`, { method: 'GET' })
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

      if (current.etag !== input.ifMatch) {
        throw new CrmPreconditionError(
          `If-Match ${input.ifMatch} does not match the current ${input.objectName} version ${current.etag}.`,
          current.etag,
        );
      }

      const target = TWENTY_OBJECT_PATH[input.objectName];
      const data = toUpdatePayload(
        input.objectName,
        input.field,
        input.value,
        current.properties,
        current.composites,
      );
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
              { method: 'PATCH', body: data },
            )
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
        ...current.properties,
        id: input.id,
        ...(isRecord(raw) ? raw : {}),
        [input.field]: input.value,
      });

      if (!updated) {
        throw new Error(`Twenty response is missing ${target.updateMutationName}.id`);
      }

      return {
        ...updated,
        properties: {
          ...current.properties,
          [input.field]: input.value,
        },
        label: labelFromProperties(input.objectName, {
          ...current.properties,
          [input.field]: input.value,
        }),
      };
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
        await requestJson(
          style === 'rest' ? `/rest/notes/${noteId}` : '/graphql',
          style === 'rest'
            ? { method: 'DELETE' }
            : {
                method: 'POST',
                body: {
                  query: 'mutation Delete($id: UUID!) { deleteNote(id: $id) { id } }',
                  variables: { id: noteId },
                },
              },
        ).catch(() => undefined);
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
      const restPath =
        input.objectName === 'person'
          ? '/rest/people'
          : input.objectName === 'company'
            ? '/rest/companies'
            : input.objectName === 'opportunity'
              ? '/rest/opportunities'
              : input.objectName === 'note'
                ? '/rest/notes'
                : '/rest/noteTargets';
      const mutationName = `delete${input.objectName.charAt(0).toUpperCase()}${input.objectName.slice(1)}`;

      if (style === 'rest') {
        await requestJson(`${restPath}/${input.id}`, { method: 'DELETE' });
        return;
      }

      await requestJson('/graphql', {
        method: 'POST',
        body: {
          query: `mutation Delete($id: UUID!) { ${mutationName}(id: $id) { id } }`,
          variables: { id: input.id },
        },
      });
    },
  };
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

