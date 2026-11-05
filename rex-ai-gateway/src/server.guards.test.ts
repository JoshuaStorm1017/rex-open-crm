import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('gateway guards', () => {
  it('previews, confirms, replays, and audits a compound create', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const intent = 'add Acme Corp as a company and a $50k deal for Jane Doe';
    const planned = await post(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent,
    });

    expect(planned.response.status).toBe(200);
    expect(client.created).toHaveLength(0);

    const tools = isRecord(planned.payload) && isRecord(planned.payload.proposal)
      ? planned.payload.proposal.tools
      : undefined;
    const body = { workspaceId: 'ws_demo', confirmed: true, tools };
    const executed = await post(gateway, '/v1/ai/act', body, {
      'idempotency-key': 'command-bar-demo-1',
      'x-rex-actor': 'ada@analytical.example',
    });
    const replayed = await post(gateway, '/v1/ai/act', body, {
      'idempotency-key': 'command-bar-demo-1',
      'x-rex-actor': 'ada@analytical.example',
    });

    expect(executed.response.status).toBe(200);
    expect(replayed.response.headers.get('idempotency-replayed')).toBe('true');
    expect(client.created).toHaveLength(3);
    expect(client.created[2]?.properties.amount).toBe(50000);
    expect(client.created[2]?.properties.companyId).toBe(client.created[0]?.id);

    const conflict = await post(
      gateway,
      '/v1/ai/act',
      { workspaceId: 'ws_demo', confirmed: true, tools: [{ name: 'create_company', args: { name: 'Other' } }] },
      { 'idempotency-key': 'command-bar-demo-1' },
    );

    expect(conflict.response.status).toBe(409);
    expect(conflict.payload).toMatchObject({ reason: 'idempotency_conflict' });
    expect(client.created).toHaveLength(3);

    const audit = await fetch(`${gateway.url}/v1/ai/audit`);
    const auditBody: unknown = await audit.json();

    expect(auditBody).toMatchObject({ ok: true });
    if (!isRecord(auditBody) || !Array.isArray(auditBody.entries)) {
      return;
    }

    expect(auditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'ada@analytical.example',
          action: 'act',
          ok: true,
          confirmed: true,
          tools: ['create_company', 'create_person', 'create_opportunity'],
        }),
      ]),
    );
  });

  it('searches and updates only when If-Match matches', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const found = await post(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'search_records', args: { object: 'company', query: 'Analytical' } }],
    });

    expect(found.response.status).toBe(200);
    expect(found.payload).toMatchObject({
      results: [{ tool: 'search_records', status: 'found', records: [{ id: company.id, etag: 'v1' }] }],
    });

    const planned = await post(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: `update company ${company.id} set domain to engines.example`,
    });
    const tools = isRecord(planned.payload) && isRecord(planned.payload.proposal)
      ? planned.payload.proposal.tools
      : undefined;
    const updated = await post(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      tools,
    });
    const stale = await post(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      tools: [
        {
          name: 'update_record',
          args: {
            object: 'company',
            id: company.id,
            field: 'domain',
            value: 'old.example',
            ifMatch: 'v1',
          },
        },
      ],
    });
    const missing = await post(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: { object: 'company', id: company.id, field: 'domain', value: 'old.example' },
        },
      ],
    });

    expect(updated.response.status).toBe(200);
    expect(client.created[0]?.properties.domain).toBe('engines.example');
    expect(client.created[0]?.etag).toBe('v2');
    expect(stale.response.status).toBe(412);
    expect(stale.payload).toMatchObject({ refused: true, reason: 'precondition_failed' });
    expect(missing.payload).toMatchObject({
      refused: true,
      reason: 'missing_required_fields',
      missingFields: ['ifMatch'],
    });
    expect(client.created[0]?.properties.domain).toBe('engines.example');
  });

  it('refuses an ambiguous name match and requires a bearer token when configured', async () => {
    const client = createMockTwentyCrmClient();
    await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme North' });
    await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme South' });
    const open = await openGateway(client);
    const ambiguous = await post(open, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update company named Acme set domain to acme.example',
    });

    expect(ambiguous.response.status).toBe(400);
    expect(ambiguous.payload).toMatchObject({ refused: true, reason: 'ambiguous_intent' });
    expect(client.created.every((record) => record.properties.domain === undefined)).toBe(true);

    const locked = await openGateway(client, 'test-gateway-token');
    const denied = await post(locked, '/v1/ai/tools', {});
    const allowed = await fetch(`${locked.url}/v1/ai/tools`, {
      headers: { authorization: 'Bearer test-gateway-token' },
    });
    const catalog: unknown = await allowed.json();

    expect(denied.response.status).toBe(401);
    expect(denied.payload).toMatchObject({ refused: true, reason: 'unauthorized' });
    expect(allowed.status).toBe(200);
    expect(catalog).toMatchObject({
      ok: true,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'search_records' }),
        expect.objectContaining({ name: 'update_record' }),
      ]),
    });
  });
});

async function openGateway(
  client: ReturnType<typeof createMockTwentyCrmClient>,
  bearerToken?: string,
): Promise<RunningGateway> {
  const gateway = await startGateway({ client, port: 0, bearerToken });
  closers.push(() => gateway.close());
  return gateway;
}

async function post(
  gateway: RunningGateway,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: path === '/v1/ai/tools' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: path === '/v1/ai/tools' ? undefined : JSON.stringify(body),
  });

  return { response, payload: await response.json() };
}
