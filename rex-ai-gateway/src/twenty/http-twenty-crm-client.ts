import { isRecord } from '../is-record';
import { CrmNotFoundError, CrmPreconditionError } from './crm-errors';
import {
  TWENTY_CREATE_TARGET,
  TWENTY_OBJECT_PATH,
  graphqlSearchFilter,
  restSearchFilter,
  toCompanyPayload,
  toOpportunityPayload,
  toPersonPayload,
  toUpdatePayload,
} from './map-to-twenty-payload';
import { crmRecordFromTwenty, labelFromProperties, readEtag } from './record-fields';
import {
  type CreateCompanyInput,
  type CreateOpportunityInput,
  type CreatePersonInput,
  type CreatedRecord,
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
  apiKey: string;
  style?: TwentyApiStyle;
  fetchImpl?: typeof fetch;
};

const MAX_ERROR_BODY_CHARS = 300;

type JsonResult = {
  status: number;
  body: unknown;
};

export function readHttpClientConfigFromEnv(
  env: NodeJS.ProcessEnv,
): TwentyHttpClientConfig | undefined {
  const apiUrl = env.TWENTY_API_URL?.trim() ?? '';
  const apiKey = env.TWENTY_API_KEY?.trim() ?? '';

  if (apiUrl.length === 0 && apiKey.length === 0) {
    return undefined;
  }

  if (apiUrl.length === 0 || apiKey.length === 0) {
    throw new Error(
      'Set both TWENTY_API_URL and TWENTY_API_KEY, or neither to use the in-memory mock.',
    );
  }

  const style = env.TWENTY_API_STYLE?.trim() || 'rest';

  if (style !== 'rest' && style !== 'graphql') {
    throw new Error('TWENTY_API_STYLE must be "rest" or "graphql".');
  }

  return { apiUrl, apiKey, style };
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
      Authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    };

    if (init.ifMatch) {
      headers['If-Match'] = init.ifMatch;
    }

    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const body: unknown = text.length === 0 ? undefined : JSON.parse(text);

    if (!response.ok) {
      if (response.status === 404) {
        throw new CrmNotFoundError(`Twenty ${style} ${path} returned 404.`);
      }

      throw new Error(
        `Twenty ${style} ${path} failed with ${response.status}: ${truncate(text)}`,
      );
    }

    if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      throw new Error(`Twenty GraphQL error: ${truncate(JSON.stringify(body.errors))}`);
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
      );
      const result =
        style === 'rest'
          ? await requestJson(`${target.restPath}/${input.id}`, {
              method: 'PATCH',
              body: data,
              ifMatch: input.ifMatch,
            })
          : await requestJson('/graphql', {
              method: 'POST',
              ifMatch: input.ifMatch,
              body: {
                query: `mutation Update($id: UUID!, $data: ${target.updateInputType}!) { ${target.updateMutationName}(id: $id, data: $data) { id updatedAt } }`,
                variables: { id: input.id, data },
              },
            });
      const raw = readMutationRecord(
        result.body,
        style === 'rest' ? target.updateMutationName : target.updateMutationName,
      );
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

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();

  if (oneLine.length <= MAX_ERROR_BODY_CHARS) {
    return oneLine;
  }

  return `${oneLine.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}
