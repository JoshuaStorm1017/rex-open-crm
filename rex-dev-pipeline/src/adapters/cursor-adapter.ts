import { randomUUID } from 'node:crypto';

import { isRecord } from '../redact';

export const CURSOR_API_ORIGIN = 'https://api.cursor.com';

const EXAMPLE_REPOSITORY = /^https:\/\/github\.com\/example\/[A-Za-z0-9._-]+$/;

export type CursorDispatchResult =
  | { outcome: 'accepted'; externalId: string; runId?: string }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'conflict_exists'; externalId: string };

export type CursorReconcileResult =
  | { outcome: 'present'; externalId: string }
  | { outcome: 'absent' }
  | { outcome: 'uncertain' };

export type CursorLaunchInput = {
  prompt: string;
  repository: string;
  startingRef: string;
  name?: string;
  agentId?: string;
};

export type CursorFollowUpInput = {
  agentId: string;
  prompt: string;
};

export type CursorFollowUpReconcileInput = {
  agentId: string;
  intendedAt: string;
  knownRunIds: string[];
};

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponse>;

export type CursorCloudAdapterOptions = {
  enabled: boolean;
  apiKey?: string;
  fetchImpl?: FetchLike;
  origin?: string;
};

// v1 webhooks are documented as coming soon, so this client only uses GET
// after a mutation. Follow-up POST /v1/agents/{id}/runs has no idempotency
// key; a retry would be a second prompt, so this class never retries.
export class CursorCloudAdapter {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(private readonly options: CursorCloudAdapterOptions) {
    this.origin = options.origin ?? CURSOR_API_ORIGIN;
    this.fetchImpl = options.fetchImpl;
  }

  launch(input: CursorLaunchInput): Promise<CursorDispatchResult> {
    if (!EXAMPLE_REPOSITORY.test(input.repository)) {
      return Promise.resolve({
        outcome: 'refused',
        reason: 'example_repository_required',
      });
    }

    const disabled = this.disabled();

    if (disabled) {
      return Promise.resolve(disabled);
    }

    const agentId = input.agentId ?? `bc-${randomUUID()}`;

    return this.request({
      method: 'POST',
      path: '/v1/agents',
      body: {
        prompt: { text: input.prompt },
        name: (input.name ?? 'rex-dev-pipeline').slice(0, 100),
        repos: [{ url: input.repository, startingRef: input.startingRef }],
        autoCreatePR: false,
        workOnCurrentBranch: false,
        agentId,
      },
      conflictId: agentId,
    });
  }

  followUp(input: CursorFollowUpInput): Promise<CursorDispatchResult> {
    const disabled = this.disabled();

    if (disabled) {
      return Promise.resolve(disabled);
    }

    return this.request({
      method: 'POST',
      path: `/v1/agents/${encodeURIComponent(input.agentId)}/runs`,
      body: { prompt: { text: input.prompt } },
    });
  }

  reconcileLaunch(agentId: string): Promise<CursorReconcileResult> {
    const disabled = this.disabled();

    if (disabled) {
      return Promise.resolve({ outcome: 'uncertain' });
    }

    return this.readAgent(agentId);
  }

  async reconcileFollowUp(
    input: CursorFollowUpReconcileInput,
  ): Promise<CursorReconcileResult> {
    const disabled = this.disabled();

    if (disabled) {
      return { outcome: 'uncertain' };
    }

    const response = await this.send(
      'GET',
      `/v1/agents/${encodeURIComponent(input.agentId)}/runs?limit=20`,
    );

    if (response.outcome !== 'json') {
      return { outcome: 'uncertain' };
    }

    const items = readRunItems(response.body);
    const intendedAt = Date.parse(input.intendedAt);
    const matches = items.filter((item) => {
      if (input.knownRunIds.includes(item.id)) {
        return false;
      }

      const createdAt = Date.parse(item.createdAt);

      return Number.isFinite(createdAt) && createdAt >= intendedAt;
    });
    const match = matches[0];

    if (matches.length === 1 && match) {
      return { outcome: 'present', externalId: match.id };
    }

    if (matches.length === 0) {
      return { outcome: 'absent' };
    }

    return { outcome: 'uncertain' };
  }

  private disabled(): CursorDispatchResult | undefined {
    if (!this.options.enabled || !this.options.apiKey || !this.fetchImpl) {
      return { outcome: 'refused', reason: 'cursor_adapter_disabled' };
    }

    return undefined;
  }

  private async request(input: {
    method: string;
    path: string;
    body: unknown;
    conflictId?: string;
  }): Promise<CursorDispatchResult> {
    const response = await this.send(input.method, input.path, input.body);

    if (response.outcome === 'unknown') {
      return { outcome: 'unknown' };
    }

    if (response.outcome === 'conflict' && input.conflictId) {
      return { outcome: 'conflict_exists', externalId: input.conflictId };
    }

    if (response.outcome === 'refused') {
      return { outcome: 'refused', reason: response.reason };
    }

    if (response.outcome !== 'json') {
      return { outcome: 'unknown' };
    }

    const agentId =
      readId(response.body, 'agent') ?? readId(response.body, 'run');
    const runId = readId(response.body, 'run');

    if (!agentId) {
      return { outcome: 'unknown' };
    }

    return {
      outcome: 'accepted',
      externalId: agentId,
      ...(runId ? { runId } : {}),
    };
  }

  private async readAgent(agentId: string): Promise<CursorReconcileResult> {
    const response = await this.send(
      'GET',
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );

    if (response.outcome === 'absent') {
      return { outcome: 'absent' };
    }

    if (response.outcome !== 'json') {
      return { outcome: 'uncertain' };
    }

    const id =
      readId(response.body, 'agent') ?? readString(response.body, 'id');

    if (!id) {
      return { outcome: 'uncertain' };
    }

    return { outcome: 'present', externalId: id };
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<
    | { outcome: 'json'; body: unknown }
    | { outcome: 'unknown' }
    | { outcome: 'absent' }
    | { outcome: 'conflict' }
    | { outcome: 'refused'; reason: string }
  > {
    const fetchImpl = this.fetchImpl;
    const apiKey = this.options.apiKey;

    if (!fetchImpl || !apiKey) {
      return { outcome: 'refused', reason: 'cursor_adapter_disabled' };
    }

    try {
      const response = await fetchImpl(`${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (response.status === 409) {
        return { outcome: 'conflict' };
      }

      if (response.status === 404) {
        return { outcome: 'absent' };
      }

      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return { outcome: 'unknown' };
      }

      if (!response.ok) {
        return { outcome: 'refused', reason: `cursor_http_${response.status}` };
      }

      try {
        return { outcome: 'json', body: await response.json() };
      } catch {
        return { outcome: 'unknown' };
      }
    } catch {
      return { outcome: 'unknown' };
    }
  }
}

function readId(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  return readString(body[key], 'id');
}

function readString(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const value = body[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRunItems(body: unknown): Array<{ id: string; createdAt: string }> {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return [];
  }

  const items: Array<{ id: string; createdAt: string }> = [];

  for (const item of body.items) {
    const id = readString(item, 'id');
    const createdAt = readString(item, 'createdAt');

    if (id && createdAt) {
      items.push({ id, createdAt });
    }
  }

  return items;
}
