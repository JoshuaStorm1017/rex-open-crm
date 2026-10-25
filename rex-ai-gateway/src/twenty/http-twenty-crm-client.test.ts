import { createServer, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from '../is-record';
import { createHttpTwentyCrmClient } from './http-twenty-crm-client';
import { startGateway } from '../server';

type CapturedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('createHttpTwentyCrmClient', () => {
  it('posts allowlisted creates to Twenty REST', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      const target = captured.url ?? '';
      const mutationName = target.endsWith('/people')
        ? 'createPerson'
        : target.endsWith('/companies')
          ? 'createCompany'
          : 'createOpportunity';

      sendJson(response, 201, {
        data: { [mutationName]: { id: `${mutationName}_row` } },
      });
    });

    const client = createHttpTwentyCrmClient({
      apiUrl: twenty.url,
      apiKey: 'test-workspace-key',
      style: 'rest',
    });

    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.example',
      jobTitle: 'Mathematician',
    });
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const opportunity = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Difference Engine',
      stage: 'NEW',
      amount: 12000,
      currencyCode: 'USD',
    });

    expect(person).toMatchObject({
      id: 'createPerson_row',
      objectName: 'person',
      workspaceId: 'ws_demo',
    });
    expect(company.id).toBe('createCompany_row');
    expect(opportunity.id).toBe('createOpportunity_row');

    expect(twenty.captured.map((request) => request.url)).toEqual([
      '/rest/people',
      '/rest/companies',
      '/rest/opportunities',
    ]);
    expect(twenty.captured.every((request) => request.authorization === 'Bearer test-workspace-key')).toBe(true);
    expect(twenty.captured[0]?.body).toEqual({
      name: { firstName: 'Ada', lastName: 'Lovelace' },
      emails: {
        primaryEmail: 'ada@analytical.example',
        additionalEmails: [],
      },
      jobTitle: 'Mathematician',
    });
    expect(twenty.captured[1]?.body).toEqual({
      name: 'Analytical Engines',
      domainName: {
        primaryLinkUrl: 'https://analytical.example',
        primaryLinkLabel: '',
        secondaryLinks: [],
      },
    });
    expect(twenty.captured[2]?.body).toEqual({
      name: 'Difference Engine',
      stage: 'NEW',
      amount: { amountMicros: 12_000_000_000, currencyCode: 'USD' },
    });
    const bodies = JSON.stringify(twenty.captured.map((request) => request.body));
    expect(bodies).not.toContain('ws_demo');
    expect(bodies).not.toContain('test-workspace-key');
  });

  it('posts a GraphQL createPerson mutation', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, {
        data: { createPerson: { id: 'person_gql' } },
      });
    });

    const client = createHttpTwentyCrmClient({
      apiUrl: twenty.url,
      apiKey: 'test-workspace-key',
      style: 'graphql',
    });

    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Grace',
      lastName: 'Hopper',
    });

    expect(person.id).toBe('person_gql');
    expect(twenty.captured[0]?.url).toBe('/graphql');
    expect(twenty.captured[0]?.body).toMatchObject({
      variables: {
        data: { name: { firstName: 'Grace', lastName: 'Hopper' } },
      },
    });

    const body = twenty.captured[0]?.body;
    const query = isRecord(body) && typeof body.query === 'string' ? body.query : '';
    expect(query).toContain('createPerson');
    expect(query).toContain('PersonCreateInput');
  });

  it('forwards a gateway act call through the HTTP client', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 201, {
        data: { createPerson: { id: 'person_from_twenty' } },
      });
    });
    const gateway = await startGateway({
      port: 0,
      client: createHttpTwentyCrmClient({
        apiUrl: twenty.url,
        apiKey: 'test-workspace-key',
      }),
    });
    closers.push(() => gateway.close());

    const response = await fetch(`${gateway.url}/v1/ai/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        intent: 'create person Ada Lovelace email ada@analytical.example',
      }),
    });
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      workspaceId: 'ws_demo',
      results: [
        {
          tool: 'create_person',
          status: 'created',
          record: {
            id: 'person_from_twenty',
            objectName: 'person',
            properties: {
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: 'ada@analytical.example',
            },
          },
        },
      ],
    });
    expect(twenty.captured[0]?.url).toBe('/rest/people');
  });
});

async function startFakeTwenty(
  handler: (captured: CapturedRequest, response: ServerResponse) => void,
): Promise<{ url: string; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const text = Buffer.concat(chunks).toString('utf8');
    const entry: CapturedRequest = {
      url: request.url,
      authorization: request.headers.authorization,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
    captured.push(entry);
    handler(entry, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Fake Twenty failed to bind a port');
  }

  closers.push(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  return {
    url: `http://127.0.0.1:${address.port}`,
    captured,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
