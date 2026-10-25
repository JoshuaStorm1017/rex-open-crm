import { isRecord } from '../is-record';
import {
  type CreateCompanyInput,
  type CreateOpportunityInput,
  type CreatePersonInput,
  type CreatedRecord,
  type TwentyCrmClient,
  type TwentyObjectName,
  companyProperties,
  opportunityProperties,
  personProperties,
} from './twenty-crm-client';
import {
  TWENTY_CREATE_TARGET,
  toCompanyPayload,
  toOpportunityPayload,
  toPersonPayload,
} from './map-to-twenty-payload';

export type TwentyApiStyle = 'rest' | 'graphql';

export type TwentyHttpClientConfig = {
  apiUrl: string;
  apiKey: string;
  style?: TwentyApiStyle;
  fetchImpl?: typeof fetch;
};

const MAX_ERROR_BODY_CHARS = 300;

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
            query: `mutation Create($data: ${target.inputType}!) { ${target.mutationName}(data: $data) { id } }`,
            variables: { data: payload },
          };

    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Twenty ${style} ${path} failed with ${response.status}: ${truncate(text)}`,
      );
    }

    const parsed: unknown = text.length === 0 ? undefined : JSON.parse(text);

    if (isRecord(parsed) && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new Error(
        `Twenty GraphQL error: ${truncate(JSON.stringify(parsed.errors))}`,
      );
    }

    return {
      id: readCreatedId(parsed, target.mutationName),
      objectName,
      workspaceId,
      properties,
    };
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
  };
}

function readCreatedId(body: unknown, mutationName: string): string {
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new Error(`Twenty response is missing data.${mutationName}.id`);
  }

  const record = body.data[mutationName];

  if (!isRecord(record) || typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`Twenty response is missing data.${mutationName}.id`);
  }

  return record.id;
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();

  if (oneLine.length <= MAX_ERROR_BODY_CHARS) {
    return oneLine;
  }

  return `${oneLine.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}
