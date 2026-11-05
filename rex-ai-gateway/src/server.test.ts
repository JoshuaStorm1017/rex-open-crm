import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
import { IdempotencyStore } from './http/idempotency-store';
import { CrmPartialWriteError } from './twenty/crm-errors';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import { startGateway, type RunningGateway } from './server';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('POST /v1/ai/act', () => {
  it('creates a person, company, and opportunity from a tools array', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@analytical.example',
            jobTitle: 'Mathematician',
          },
        },
        {
          name: 'create_company',
          args: {
            name: 'Analytical Engines',
            domain: 'analytical.example',
          },
        },
        {
          name: 'create_opportunity',
          args: {
            name: 'Difference Engine',
            amount: 12000,
            currencyCode: 'USD',
          },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(isSuccess(payload)).toBe(true);

    if (!isSuccess(payload)) {
      return;
    }

    expect(payload.workspaceId).toBe('ws_demo');
    expect(payload.results.map((result) => result.tool)).toEqual([
      'create_person',
      'create_company',
      'create_opportunity',
    ]);
    expect(payload.results[0]?.record).toMatchObject({
      objectName: 'person',
      workspaceId: 'ws_demo',
      properties: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@analytical.example',
        jobTitle: 'Mathematician',
      },
    });
    expect(payload.results[0]?.record.id).toMatch(/^person_/);
    expect(payload.results[1]?.record.properties).toMatchObject({
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    expect(payload.results[2]?.record.properties).toMatchObject({
      name: 'Difference Engine',
      amount: 12000,
      currencyCode: 'USD',
      stage: 'NEW',
    });
    expect(client.created).toHaveLength(3);
  });

  it('creates the same records from a deterministic intent', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const person = await postAct(gateway, {
      workspaceId: 'ws_demo',
      intent: 'create person Ada Lovelace email ada@analytical.example job Mathematician',
    });
    const company = await postAct(gateway, {
      workspaceId: 'ws_demo',
      intent: 'create company Analytical Engines domain analytical.example',
    });
    const opportunity = await postAct(gateway, {
      workspaceId: 'ws_demo',
      intent: 'create opportunity Difference Engine amount 12000 stage NEW',
    });

    expect(person.response.status).toBe(200);
    expect(company.response.status).toBe(200);
    expect(opportunity.response.status).toBe(200);
    expect(client.created.map((record) => record.objectName)).toEqual([
      'person',
      'company',
      'opportunity',
    ]);
    expect(client.created[0]?.properties).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.example',
      jobTitle: 'Mathematician',
    });
    expect(client.created[2]?.properties).toMatchObject({
      name: 'Difference Engine',
      amount: 12000,
      stage: 'NEW',
    });
  });

  it('refuses an unknown tool and does not create', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: { firstName: 'Ada', lastName: 'Lovelace' },
        },
        { name: 'delete_workspace', args: {} },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'unknown_tool',
      toolName: 'delete_workspace',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses a tool that is missing required fields', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: { firstName: 'Ada' },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'missing_required_fields',
      toolName: 'create_person',
      missingFields: ['lastName'],
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses a negative opportunity amount and does not create', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: { name: 'Difference Engine', amount: -12000 },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'invalid_request',
      toolName: 'create_opportunity',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses a non-numeric opportunity amount and does not create', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const textAmount = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: { name: 'Difference Engine', amount: 'abc' },
        },
      ],
    });
    const booleanAmount = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: { name: 'Difference Engine', amount: true },
        },
      ],
    });

    expect(textAmount.response.status).toBe(400);
    expect(textAmount.payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'invalid_request',
      toolName: 'create_opportunity',
    });
    expect(booleanAmount.response.status).toBe(400);
    expect(booleanAmount.payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'invalid_request',
      toolName: 'create_opportunity',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses an intent that does not name a person fully', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      intent: 'create person Ada',
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'missing_required_fields',
      missingFields: ['firstName', 'lastName'],
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses args that name a different workspace', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const explicit = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            workspaceId: 'ws_other',
          },
        },
      ],
    });
    const nested = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: {
            name: 'Analytical Engines',
            companyId: 'ws_other',
          },
        },
      ],
    });

    expect(explicit.response.status).toBe(400);
    expect(explicit.payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'cross_workspace',
      toolName: 'create_person',
    });
    expect(nested.payload).toMatchObject({
      reason: 'cross_workspace',
      toolName: 'create_company',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses a request workspace that is not the bound gateway workspace', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client, 'ws_demo');

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_other',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Analytical Engines' },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'cross_workspace',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses an intent that is not a create', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      intent: 'delete all people',
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'unsafe_intent',
    });
    expect(client.created).toHaveLength(0);
  });

  it('does not write a tools array that was not confirmed from a preview', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      confirmed: true,
      tools: [
        {
          name: 'create_company',
          args: { name: 'Analytical Engines' },
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      ok: false,
      refused: true,
      reason: 'confirmation_required',
    });
    expect(client.created).toHaveLength(0);
  });

  it('returns 502 when the Twenty client fails', async () => {
    const client = createMockTwentyCrmClient();
    client.createPerson = async () => {
      throw new Error('connection refused');
    };
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: { firstName: 'Ada', lastName: 'Lovelace' },
        },
      ],
    });

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      refused: false,
      reason: 'upstream_error',
    });
  });

  it('refuses a new idempotency key instead of forgetting an old one', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await startGateway({
      client,
      port: 0,
      idempotency: new IdempotencyStore(1),
    });
    closers.push(() => gateway.close());

    const firstPlan = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_company', args: { name: 'Analytical Engines' } }],
    });
    const first = await postJson(
      gateway,
      '/v1/ai/act',
      {
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(firstPlan.payload),
      },
      { 'idempotency-key': 'first-company-key' },
    );
    const secondPlan = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_company', args: { name: 'Other Engines' } }],
    });
    const second = await postJson(
      gateway,
      '/v1/ai/act',
      {
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(secondPlan.payload),
      },
      { 'idempotency-key': 'second-company-key' },
    );

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(503);
    expect(second.payload).toMatchObject({ refused: true, reason: 'invalid_request' });
    expect(client.created.map((record) => record.properties.name)).toEqual([
      'Analytical Engines',
    ]);
  });

  it('rolls back an earlier create when a later tool fails', async () => {
    const client = createMockTwentyCrmClient();
    client.createPerson = async () => {
      throw new Error('person write failed');
    };
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        { name: 'create_company', args: { name: 'Analytical Engines' } },
        { name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } },
      ],
    });

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({ reason: 'upstream_error' });
    expect(JSON.stringify(payload)).toContain('rolled back');
    expect(client.created).toHaveLength(0);
  });

  it('reports records that could not be rolled back', async () => {
    const client = createMockTwentyCrmClient();
    client.createPerson = async () => {
      throw new Error('person write failed');
    };
    client.deleteRecord = async () => {
      throw new Error('delete failed');
    };
    const gateway = await openGateway(client);

    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        { name: 'create_company', args: { name: 'Analytical Engines' } },
        { name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } },
      ],
    });

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ reason: 'partial_failure' });
    expect(client.created).toHaveLength(1);
  });

  it('names a note that could not be deleted after a failed link', async () => {
    const client = createMockTwentyCrmClient();
    client.createNote = async () => {
      throw new CrmPartialWriteError('Linking the note failed. The note could not be deleted.', [
        'note_orphan',
      ]);
    };
    const gateway = await openGateway(client);
    const { response, payload } = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        { name: 'create_company', args: { name: 'Analytical Engines' } },
        {
          name: 'create_note',
          args: { body: 'A fictional note.', targetObject: 'company', targetId: '$0' },
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      reason: 'partial_failure',
      remainingRecordIds: ['note_orphan'],
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses an unknown opportunity stage and an unsafe search query', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const stage = await postAct(gateway, {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: { name: 'Difference Engine', stage: 'WON' },
        },
      ],
    });
    const search = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'search_records',
          args: { object: 'company', query: 'Acme" or name[eq]:"x' },
        },
      ],
    });

    expect(stage.payload).toMatchObject({ refused: true, reason: 'invalid_request' });
    expect(search.payload).toMatchObject({ refused: true, reason: 'invalid_request' });
    expect(client.created).toHaveLength(0);
  });
});

async function openGateway(
  client: ReturnType<typeof createMockTwentyCrmClient>,
  boundWorkspaceId?: string,
): Promise<RunningGateway> {
  const gateway = await startGateway({
    client,
    port: 0,
    boundWorkspaceId,
  });
  closers.push(() => gateway.close());
  return gateway;
}

async function postAct(
  gateway: RunningGateway,
  body: unknown,
): Promise<{ response: Response; payload: unknown }> {
  if (isRecord(body) && body.confirmed === true && !('proposalId' in body)) {
    return postJson(gateway, '/v1/ai/act', body);
  }

  const planned = await postJson(gateway, '/v1/ai/plan', body);

  if (
    !isRecord(planned.payload) ||
    planned.payload.ok !== true ||
    !isRecord(planned.payload.proposal) ||
    typeof planned.payload.proposal.id !== 'string'
  ) {
    return planned;
  }

  const workspaceId =
    isRecord(body) && typeof body.workspaceId === 'string' ? body.workspaceId : 'ws_demo';

  return postJson(gateway, '/v1/ai/act', {
    workspaceId,
    confirmed: true,
    proposalId: planned.payload.proposal.id,
  });
}

async function postJson(
  gateway: RunningGateway,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rex-member': 'ada@analytical.example',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return { response, payload: await response.json() };
}

function proposalId(payload: unknown): string {
  return isRecord(payload) &&
    isRecord(payload.proposal) &&
    typeof payload.proposal.id === 'string'
    ? payload.proposal.id
    : '';
}

function isSuccess(value: unknown): value is {
  ok: true;
  workspaceId: string;
  results: Array<{
    tool: string;
    record: {
      id: string;
      objectName: string;
      workspaceId: string;
      properties: Record<string, string | number>;
    };
  }>;
} {
  return isRecord(value) && value.ok === true && Array.isArray(value.results);
}
