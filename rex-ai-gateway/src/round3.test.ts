import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeAct } from './act/execute-act';
import { proposeAct } from './act/propose-act';
import { toClearPayload } from './twenty/map-to-twenty-payload';
import { clearPinnedDnsCache, fetchWithPinnedDns } from './http/pinned-fetch';
import { createOpenAiLlmProvider } from './llm/openai-llm-provider';
import { createMockLlmProvider } from './llm/mock-llm-provider';
import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  clearPinnedDnsCache();

  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('openai tool calls', () => {
  it('validates tool-call arguments and does not run free-form JSON', async () => {
    const client = createMockTwentyCrmClient();
    const provider = createOpenAiLlmProvider(
      {
        provider: 'openai',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'test-llm-key',
        model: 'mock-model',
      },
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tool_choice?: string;
          tools?: Array<{ function?: { parameters?: { additionalProperties?: boolean } } }>;
        };

        expect(body.tool_choice).toBe('auto');
        expect(body.tools?.[0]?.function?.parameters?.additionalProperties).toBe(false);

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tools: [{ name: 'create_company', args: { name: 'Injected' } }],
                  }),
                  tool_calls: [
                    {
                      function: {
                        name: 'create_company',
                        arguments: JSON.stringify({ name: 'Acme Corp', dropTable: 'people' }),
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
      { workspaceId: 'ws_demo', intent: 'create company Acme Corp' },
      client,
      provider,
    );

    expect(planned).toMatchObject({
      ok: false,
      refused: true,
      reason: 'invalid_request',
      toolName: 'create_company',
    });
    expect(client.created).toHaveLength(0);
  });

  it('turns an allowlisted tool call into a preview and does not write', async () => {
    const client = createMockTwentyCrmClient();
    const provider = createOpenAiLlmProvider(
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
                  content: 'I already created it.',
                  tool_calls: [
                    {
                      function: {
                        name: 'delete_workspace',
                        arguments: '{}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const refused = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'delete the workspace' },
      client,
      provider,
    );
    const allowed = createOpenAiLlmProvider(
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
                        name: 'create_company',
                        arguments: JSON.stringify({ name: 'Acme Corp' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const planned = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'create company Acme Corp' },
      client,
      allowed,
    );

    expect(refused).toMatchObject({ refused: true, reason: 'unknown_tool', toolName: 'delete_workspace' });
    expect(planned).toMatchObject({
      ok: true,
      proposal: {
        summary: 'Create company “Acme Corp”.',
        tools: [{ name: 'create_company', args: { name: 'Acme Corp' } }],
      },
    });
    expect(client.created).toHaveLength(0);
  });
});

describe('open record', () => {
  it('updates the open deal and adds a note without the model choosing an id', async () => {
    const client = createMockTwentyCrmClient();
    const deal = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      stage: 'NEW',
    });
    const llm = createMockLlmProvider();
    const planned = await proposeAct(
      {
        workspaceId: 'ws_demo',
        intent: "update this deal's stage to Proposal",
        context: { objectName: 'opportunity', recordId: deal.id },
      },
      client,
      llm,
    );
    const noted = await proposeAct(
      {
        workspaceId: 'ws_demo',
        intent: 'add a note: Called the buyer',
        context: { objectName: 'opportunity', recordId: deal.id },
      },
      client,
      llm,
    );

    expect(planned).toMatchObject({
      ok: true,
      proposal: {
        tools: [
          {
            name: 'update_record',
            args: {
              object: 'opportunity',
              id: deal.id,
              field: 'stage',
              value: 'PROPOSAL',
              ifMatch: deal.etag,
            },
          },
        ],
      },
    });
    expect(noted).toMatchObject({
      ok: true,
      proposal: {
        tools: [
          {
            name: 'create_note',
            args: {
              body: 'Called the buyer',
              targetObject: 'opportunity',
              targetId: deal.id,
            },
          },
        ],
      },
    });
    expect(client.created).toHaveLength(1);

    if (!planned.ok) {
      return;
    }

    const executed = await executeAct(
      { workspaceId: 'ws_demo', confirmed: true, tools: planned.proposal.tools },
      client,
    );

    expect(executed.ok).toBe(true);
    expect(client.created[0]?.properties.stage).toBe('PROPOSAL');
  });
});

describe('multi-match create', () => {
  it('lets the member choose an existing person or create a new one', async () => {
    const client = createMockTwentyCrmClient();
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.north@example.test',
    });
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.south@example.test',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'add a note to person named Jane Doe: Met at the fair',
    });

    expect(planned.payload).toMatchObject({
      ok: true,
      proposal: {
        choice: {
          candidates: [
            expect.objectContaining({ label: 'Jane Doe · jane.north@example.test', action: 'use' }),
            expect.objectContaining({ label: 'Jane Doe · jane.south@example.test', action: 'use' }),
            expect.objectContaining({
              id: 'create_new',
              action: 'create',
              label: 'Create new person “Jane Doe” and add the note',
            }),
          ],
        },
      },
    });

    const created = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
      choiceId: 'create_new',
    });

    expect(created.response.status).toBe(200);
    expect(client.created.filter((record) => record.objectName === 'person')).toHaveLength(3);
    expect(client.created.some((record) => record.objectName === 'note')).toBe(true);
    expect(created.payload).toMatchObject({
      ok: true,
      undo: { id: expect.stringMatching(/^undo_/), summary: expect.stringContaining('Undo') },
    });
    expect(JSON.stringify(created.payload)).not.toContain('effects');
  });
});

describe('undo', () => {
  it('restores a previously empty field and deletes a created record', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
    client.createPerson = async () => {
      throw new Error('person write failed');
    };
    const rolled = await executeAct(
      {
        workspaceId: 'ws_demo',
        tools: [
          {
            name: 'update_record',
            args: {
              object: 'company',
              id: company.id,
              field: 'domain',
              value: 'acme.example',
              ifMatch: company.etag,
            },
          },
          { name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } },
        ],
      },
      client,
    );

    expect(rolled).toMatchObject({ ok: false, reason: 'upstream_error' });
    expect(client.created[0]?.properties.domain).toBeUndefined();

    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        { name: 'create_company', args: { name: 'Analytical Engines' } },
        {
          name: 'update_record',
          args: {
            object: 'company',
            id: company.id,
            field: 'domain',
            value: 'acme.example',
            ifMatch: client.created[0]?.etag,
          },
        },
      ],
    });
    const acted = await postJson(
      gateway,
      '/v1/ai/act',
      {
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(planned.payload),
      },
      { 'idempotency-key': 'undo-demo-1' },
    );
    const undoId =
      isRecord(acted.payload) && isRecord(acted.payload.undo) && typeof acted.payload.undo.id === 'string'
        ? acted.payload.undo.id
        : '';
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId,
    });
    const audit = await fetch(`${gateway.url}/v1/ai/audit`, {
      headers: { 'x-rex-member': 'ada@analytical.example' },
    });
    const auditBody: unknown = await audit.json();

    expect(acted.response.status).toBe(200);
    expect(undone.response.status).toBe(200);
    expect(client.created.some((record) => record.properties.name === 'Analytical Engines')).toBe(false);
    expect(client.created[0]?.properties.domain).toBeUndefined();
    expect(auditBody).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ action: 'undo', ok: true, summary: 'Reversed the last confirmed change.' }),
      ]),
    });
  });

  it('keeps the last undo ticket in sqlite', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-ai-undo-'));
    const filename = path.join(directory, 'state.sqlite');
    const first = openGatewayState(filename);
    const ticket = first.undos.save('member_ada', 'ws_demo', [
      { kind: 'created', objectName: 'company', id: 'company_1' },
    ]);
    first.close();
    const second = openGatewayState(filename);

    expect(second.undos.peek(ticket?.id ?? '', 'member_ada', 'ws_demo').ok).toBe(true);
    second.close();
  });
});

describe('permission catalog', () => {
  it('hides tools the member cannot perform and refuses them on plan', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        { objectName: 'person', canRead: true, canUpdate: false, canSoftDelete: false },
        { objectName: 'company', canRead: true, canUpdate: true, canSoftDelete: true },
        { objectName: 'opportunity', canRead: false, canUpdate: false, canSoftDelete: false },
        { objectName: 'note', canRead: true, canUpdate: false, canSoftDelete: false },
      ],
    });
    const gateway = await openGateway(client);
    const tools = await fetch(`${gateway.url}/v1/ai/tools`, {
      headers: { 'x-rex-member': 'ada@analytical.example' },
    });
    const catalog: unknown = await tools.json();
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } }],
    });

    expect(tools.status).toBe(200);
    expect(catalog).toMatchObject({ ok: true });
    const names =
      isRecord(catalog) && Array.isArray(catalog.tools)
        ? catalog.tools.map((tool) => (isRecord(tool) ? tool.name : undefined))
        : [];

    expect(names).toEqual(['create_company', 'search_records', 'update_record']);
    const update = isRecord(catalog) && Array.isArray(catalog.tools) ? catalog.tools[2] : undefined;
    expect(update).toMatchObject({
      inputSchema: { properties: { object: { enum: ['company'] } } },
    });
    expect(planned.payload).toMatchObject({ refused: true, reason: 'forbidden', toolName: 'create_person' });
    expect(client.created).toHaveLength(0);
  });
});

describe('pinned public hosts', () => {
  it('refuses a Twenty hostname that resolves to a private address', async () => {
    const lookupImpl = async () => [{ address: '10.1.2.3', family: 4 }];

    await expect(
      fetchWithPinnedDns(
        'https://crm.example/rest/companies',
        { method: 'GET' },
        fetch,
        'TWENTY_API_URL',
        lookupImpl,
      ),
    ).rejects.toThrow(/TWENTY_API_URL resolves to a non-public address/);
  });

  it('does not resolve a loopback Twenty origin', async () => {
    let lookedUp = false;

    await fetchWithPinnedDns(
      'http://127.0.0.1:9/rest/companies',
      { method: 'GET' },
      fetch,
      'TWENTY_API_URL',
      async () => {
        lookedUp = true;
        return [{ address: '10.1.2.3', family: 4 }];
      },
    ).catch(() => undefined);

    expect(lookedUp).toBe(false);
  });
});

describe('toClearPayload', () => {
  it('clears an email that was empty before the write', () => {
    expect(toClearPayload('person', 'email', {}, undefined)).toEqual({
      emails: { primaryEmail: '', additionalEmails: [] },
    });
  });
});

async function openGateway(
  client: ReturnType<typeof createMockTwentyCrmClient>,
): Promise<RunningGateway> {
  const gateway = await startGateway({ client, port: 0 });
  closers.push(() => gateway.close());
  return gateway;
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
  return isRecord(payload) && isRecord(payload.proposal) && typeof payload.proposal.id === 'string'
    ? payload.proposal.id
    : '';
}
