import { afterEach, describe, expect, it } from 'vitest';

import { proposeAct } from './act/propose-act';
import { fetchWithPinnedDns } from './http/pinned-fetch';
import { isRecord } from './is-record';
import { createOpenAiLlmProvider, plannerSystemPrompt } from './llm/openai-llm-provider';
import { startGateway, type RunningGateway } from './server';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('provider cleartext', () => {
  it('does not send the API key to a public http host', async () => {
    let called = false;

    await expect(
      fetchWithPinnedDns(
        'http://llm.example/v1/chat/completions',
        { method: 'POST' },
        async () => {
          called = true;
          return new Response('{}');
        },
        'REX_AI_BASE_URL',
      ),
    ).rejects.toThrow(/https/);
    expect(called).toBe(false);
  });
});

describe('match details', () => {
  it('shows email, domain, and city, and stage with amount, and still offers create new', async () => {
    const client = createMockTwentyCrmClient();
    await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      domain: 'north.example',
      city: 'Lisbon',
    });
    await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      domain: 'south.example',
      city: 'Porto',
    });
    await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Expansion',
      stage: 'NEW',
      amount: 1000,
    });
    await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Expansion',
      stage: 'PROPOSAL',
      amount: 50000,
    });
    const gateway = await openGateway(client);
    const companies = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update company named Acme set website to https://acme.example',
    });
    const deals = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update opportunity named Expansion set closeDate to 2026-12-01',
    });

    expect(companies.payload).toMatchObject({
      ok: true,
      proposal: {
        choice: {
          candidates: [
            expect.objectContaining({
              label: 'Acme',
              detail: 'north.example · Lisbon',
              action: 'use',
            }),
            expect.objectContaining({
              label: 'Acme',
              detail: 'south.example · Porto',
              action: 'use',
            }),
            expect.objectContaining({ id: 'create_new', action: 'create' }),
          ],
        },
      },
    });
    expect(deals.payload).toMatchObject({
      ok: true,
      proposal: {
        choice: {
          candidates: [
            expect.objectContaining({ label: 'Expansion', detail: 'NEW · $1,000', action: 'use' }),
            expect.objectContaining({
              label: 'Expansion',
              detail: 'PROPOSAL · $50,000',
              action: 'use',
            }),
          ],
        },
      },
    });
    expect(JSON.stringify(deals.payload)).not.toContain('create_new');
  });
});

describe('everyday fields and archive', () => {
  it('previews and confirms website, linkedin, address, city, amount, and close date', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const deal = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Expansion',
      stage: 'NEW',
    });
    const gateway = await openGateway(client);
    const writes: Array<{ object: string; id: string; field: string; value: string | number }> = [
      { object: 'company', id: company.id, field: 'website', value: 'https://acme.example' },
      { object: 'company', id: company.id, field: 'city', value: 'Lisbon' },
      { object: 'company', id: company.id, field: 'address', value: '1 Harbour Road' },
      { object: 'person', id: person.id, field: 'linkedin', value: 'https://www.linkedin.com/in/ada' },
      { object: 'opportunity', id: deal.id, field: 'amount', value: 50000 },
      { object: 'opportunity', id: deal.id, field: 'closeDate', value: '2026-12-01' },
    ];

    for (const write of writes) {
      const current = client.created.find((record) => record.id === write.id);

      if (!current) {
        throw new Error(`Missing ${write.id}`);
      }

      const planned = await postJson(gateway, '/v1/ai/plan', {
        workspaceId: 'ws_demo',
        tools: [
          {
            name: 'update_record',
            args: { ...write, ifMatch: current.etag },
          },
        ],
      });
      const acted = await postJson(gateway, '/v1/ai/act', {
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(planned.payload),
      });

      expect(planned.payload).toMatchObject({ ok: true });
      expect(acted.response.status).toBe(200);
    }

    expect(client.created.find((record) => record.id === company.id)?.properties).toMatchObject({
      website: 'https://acme.example',
      domain: 'https://acme.example',
      city: 'Lisbon',
      address: '1 Harbour Road',
    });
    expect(client.created.find((record) => record.id === person.id)?.properties.linkedin).toBe(
      'https://www.linkedin.com/in/ada',
    );
    expect(client.created.find((record) => record.id === deal.id)?.properties).toMatchObject({
      amount: 50000,
      closeDate: '2026-12-01',
    });
  });

  it('archives with preview and confirm, then undo restores the record', async () => {
    const client = createMockTwentyCrmClient();
    await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'archive company named Acme',
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const hidden = await client.searchRecords({
      workspaceId: 'ws_demo',
      objectName: 'company',
      query: 'Acme',
      limit: 10,
    });
    const undoId = undoIdFrom(acted.payload);
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId,
    });
    const restored = await client.searchRecords({
      workspaceId: 'ws_demo',
      objectName: 'company',
      query: 'Acme',
      limit: 10,
    });

    expect(planned.payload).toMatchObject({
      ok: true,
      proposal: { tools: [expect.objectContaining({ name: 'archive_record' })] },
    });
    expect(acted.response.status).toBe(200);
    expect(hidden).toHaveLength(0);
    expect(undone.response.status).toBe(200);
    expect(restored).toHaveLength(1);
  });
});

describe('note undo etag', () => {
  it('refuses a changed note and keeps the undo for a later retry', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_note',
          args: { body: 'Called the buyer', targetObject: 'person', targetId: person.id },
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const note = client.created.find((record) => record.objectName === 'note' && record.properties.body);
    const undoId = undoIdFrom(acted.payload);

    if (!note) {
      throw new Error('Expected a note.');
    }

    note.etag = 'v9';
    note.properties.body = 'Edited after the act';
    const blocked = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId,
    });

    expect(blocked.response.status).toBe(412);
    expect(blocked.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
    });
    expect(client.created.some((record) => record.id === note.id)).toBe(true);
    expect(note.properties.body).toBe('Edited after the act');

    note.etag = 'v1';
    const retried = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId,
    });

    expect(retried.response.status).toBe(200);
    expect(client.created.some((record) => record.id === note.id)).toBe(false);
  });
});

describe('visible record snapshot', () => {
  it('shows labels to the model and resolves handles without accepting a forged id', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.example',
    });
    let systemPrompt = '';
    const provider = createOpenAiLlmProvider(
      {
        provider: 'openai',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'test-llm-key',
        model: 'mock-model',
      },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
        systemPrompt = body.messages?.[0]?.content ?? '';

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: 'update_record',
                        arguments: JSON.stringify({
                          object: 'company',
                          id: 'person_forged',
                          field: 'jobTitle',
                          value: 'Mathematician',
                          recordRef: 'p1',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );
    const planned = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'set Ada Lovelace job title to Mathematician' },
      client,
      provider,
    );
    const forged = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'set a job title to Mathematician' },
      client,
      createOpenAiLlmProvider(
        {
          provider: 'openai',
          baseUrl: 'https://llm.example/v1',
          apiKey: 'test-llm-key',
          model: 'mock-model',
        },
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        function: {
                          name: 'update_record',
                          arguments: JSON.stringify({
                            object: 'person',
                            id: 'person_forged',
                            field: 'jobTitle',
                            value: 'Mathematician',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    expect(systemPrompt).toContain('Ada Lovelace');
    expect(systemPrompt).toContain('recordRef p1');
    expect(systemPrompt).not.toContain(person.id);
    expect(planned).toMatchObject({
      ok: true,
      proposal: {
        tools: [
          expect.objectContaining({
            args: expect.objectContaining({ id: person.id, object: 'person', field: 'jobTitle' }),
          }),
        ],
      },
    });
    expect(JSON.stringify(planned)).not.toContain('person_forged');
    expect(forged).toMatchObject({
      ok: false,
      refused: true,
      reason: 'invalid_request',
    });
    expect(plannerSystemPrompt({ intent: 'x', workspaceId: 'ws_demo', client }).includes(person.id)).toBe(
      false,
    );
  });
});

describe('create and update gates', () => {
  it('refuses create when update is allowed and create is not', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'company',
          canRead: true,
          canUpdate: true,
          canCreate: false,
          canSoftDelete: false,
        },
        { objectName: 'person', canRead: true, canUpdate: false, canCreate: false, canSoftDelete: false },
        {
          objectName: 'opportunity',
          canRead: false,
          canUpdate: false,
          canCreate: false,
          canSoftDelete: false,
        },
        { objectName: 'note', canRead: true, canUpdate: true, canCreate: false, canSoftDelete: false },
      ],
    });
    const gateway = await openGateway(client);
    const tools = await fetch(`${gateway.url}/v1/ai/tools`, {
      headers: { 'x-rex-member': 'ada@analytical.example' },
    });
    const catalog: unknown = await tools.json();
    const create = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_company', args: { name: 'Other' } }],
    });
    const update = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: {
            object: 'company',
            id: company.id,
            field: 'city',
            value: 'Lisbon',
            ifMatch: company.etag,
          },
        },
      ],
    });
    const names =
      isRecord(catalog) && Array.isArray(catalog.tools)
        ? catalog.tools.map((tool) => (isRecord(tool) ? tool.name : undefined))
        : [];

    expect(names).toEqual(['search_records', 'update_record']);
    expect(create.payload).toMatchObject({ refused: true, reason: 'forbidden', toolName: 'create_company' });
    expect(update.payload).toMatchObject({ ok: true });
    expect(client.created.filter((record) => record.properties.name === 'Other')).toHaveLength(0);
  });
});

async function openGateway(client: ReturnType<typeof createMockTwentyCrmClient>): Promise<RunningGateway> {
  const gateway = await startGateway({ port: 0, client });
  closers.push(() => gateway.close());
  return gateway;
}

async function postJson(
  gateway: RunningGateway,
  path: string,
  body: unknown,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rex-member': 'ada@analytical.example',
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();

  return { response, payload };
}

function proposalId(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.proposal) && typeof payload.proposal.id === 'string') {
    return payload.proposal.id;
  }

  throw new Error('Missing proposal id');
}

function undoIdFrom(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.undo) && typeof payload.undo.id === 'string') {
    return payload.undo.id;
  }

  throw new Error('Missing undo id');
}
