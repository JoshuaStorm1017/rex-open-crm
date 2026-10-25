import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
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
            workspaceId: 'ws_demo',
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
      reason: 'unmapped_intent',
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
  const response = await fetch(`${gateway.url}/v1/ai/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { response, payload: await response.json() };
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
