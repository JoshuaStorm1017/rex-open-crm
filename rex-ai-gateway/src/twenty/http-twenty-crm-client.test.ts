import { createServer, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { withMemberCredential } from '../auth/call-context';
import { isRecord } from '../is-record';
import { CrmPartialWriteError, CrmPreconditionError } from './crm-errors';
import {
  createHttpTwentyCrmClient,
  readTwentyApiOrigin,
} from './http-twenty-crm-client';
import {
  graphqlDomainHostFilter,
  restDomainHostFilter,
} from './map-to-twenty-payload';
import { startGateway } from '../server';

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  ifMatch: string | undefined;
  body: unknown;
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

const memberCredential = {
  kind: 'bearer' as const,
  token: 'member-access-token-value',
};

function createClient(
  config: Parameters<typeof createHttpTwentyCrmClient>[0],
): ReturnType<typeof createHttpTwentyCrmClient> {
  const client = createHttpTwentyCrmClient(config);

  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);

      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) =>
        withMemberCredential(memberCredential, () =>
          (value as (...inner: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          ),
        );
    },
  });
}

describe('readTwentyApiOrigin', () => {
  it('accepts a loopback http origin and rejects anything else on http', () => {
    expect(readTwentyApiOrigin('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000',
    );
    expect(readTwentyApiOrigin('https://crm.example')).toBe(
      'https://crm.example',
    );
    expect(() => readTwentyApiOrigin('http://crm.example')).toThrow(/loopback/);
    expect(() => readTwentyApiOrigin('http://127.0.0.1:3000/rest')).toThrow(
      /path/,
    );
    expect(() =>
      readTwentyApiOrigin('http://user:pass@127.0.0.1:3000'),
    ).toThrow(/credentials/);
    expect(() => readTwentyApiOrigin('file:///tmp/twenty')).toThrow(/http/);
    expect(() => readTwentyApiOrigin('https://10.0.0.1')).toThrow(/non-public/);
    expect(() => readTwentyApiOrigin('https://169.254.169.254')).toThrow(
      /non-public/,
    );
    expect(() =>
      readTwentyApiOrigin('https://metadata.google.internal'),
    ).toThrow(/metadata|local/);
    expect(() => readTwentyApiOrigin('https://[::ffff:a9fe:a9fe]')).toThrow(
      /non-public/,
    );
  });
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

    const client = createClient({
      apiUrl: twenty.url,
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
    expect(
      twenty.captured.every(
        (request) =>
          request.authorization === 'Bearer member-access-token-value',
      ),
    ).toBe(true);
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
    const bodies = JSON.stringify(
      twenty.captured.map((request) => request.body),
    );
    expect(bodies).not.toContain('ws_demo');
    expect(bodies).not.toContain('test-workspace-key');
  });

  it('posts a GraphQL createPerson mutation', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, {
        data: { createPerson: { id: 'person_gql' } },
      });
    });

    const client = createClient({
      apiUrl: twenty.url,
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
    const query =
      isRecord(body) && typeof body.query === 'string' ? body.query : '';
    expect(query).toContain('createPerson');
    expect(query).toContain('PersonCreateInput');
  });

  it('forwards a confirmed gateway act call through the HTTP client', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      const query =
        isRecord(captured.body) && typeof captured.body.query === 'string'
          ? captured.body.query
          : '';

      if (query.includes('RexAiCapabilities')) {
        sendJson(response, 200, {
          data: {
            objects: {
              edges: [
                {
                  node: {
                    id: 'obj_person',
                    nameSingular: 'person',
                    fieldsList: [
                      { id: 'field_name', name: 'name' },
                      { id: 'field_emails', name: 'emails' },
                      { id: 'field_job', name: 'jobTitle' },
                      { id: 'field_phones', name: 'phones' },
                      { id: 'field_linkedin', name: 'linkedinLink' },
                    ],
                  },
                },
              ],
            },
            currentUser: {
              currentUserWorkspace: {
                objectPermissions: [
                  {
                    objectMetadataId: 'obj_person',
                    canReadObjectRecords: true,
                    canUpdateObjectRecords: true,
                    canSoftDeleteObjectRecords: true,
                    restrictedFields: {},
                  },
                ],
              },
            },
          },
        });
        return;
      }

      sendJson(response, 201, {
        data: { createPerson: { id: 'person_from_twenty' } },
      });
    });
    const gateway = await startGateway({
      port: 0,
      client: createClient({
        apiUrl: twenty.url,
      }),
    });
    closers.push(() => gateway.close());

    const planned = await fetch(`${gateway.url}/v1/ai/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        intent: 'create person Ada Lovelace email ada@analytical.example',
      }),
    });
    const planPayload: unknown = await planned.json();
    const proposalId =
      isRecord(planPayload) &&
      isRecord(planPayload.proposal) &&
      typeof planPayload.proposal.id === 'string'
        ? planPayload.proposal.id
        : '';
    const direct = await fetch(`${gateway.url}/v1/ai/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        confirmed: true,
        tools: [
          {
            name: 'create_person',
            args: { firstName: 'Ada', lastName: 'Lovelace' },
          },
        ],
      }),
    });

    expect(direct.status).toBe(400);
    expect(
      twenty.captured.some(
        (entry) => entry.method === 'POST' && entry.url === '/rest/people',
      ),
    ).toBe(false);

    const response = await fetch(`${gateway.url}/v1/ai/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId,
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
    expect(
      twenty.captured.filter((entry) => entry.url === '/rest/people'),
    ).toHaveLength(1);
  });

  it('searches companies and patches only when If-Match matches', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      const url = captured.url ?? '';

      if (captured.method === 'GET' && url.startsWith('/rest/companies?')) {
        sendJson(response, 200, {
          data: {
            companies: [
              {
                id: 'company_row',
                name: 'Analytical Engines',
                updatedAt: '2026-01-01T00:00:00.000Z',
                domainName: { primaryLinkUrl: 'https://analytical.example' },
              },
            ],
          },
        });
        return;
      }

      if (
        captured.method === 'GET' &&
        url.startsWith('/rest/companies/company_row')
      ) {
        sendJson(response, 200, {
          data: {
            company: {
              id: 'company_row',
              name: 'Analytical Engines',
              updatedAt: '2026-01-01T00:00:00.000Z',
              domainName: { primaryLinkUrl: 'https://analytical.example' },
            },
          },
        });
        return;
      }

      sendJson(response, 200, {
        data: {
          updateCompanies: [
            {
              id: 'company_row',
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
      });
    });
    const client = createClient({
      apiUrl: twenty.url,
      style: 'rest',
    });

    const found = await client.searchRecords({
      workspaceId: 'ws_demo',
      objectName: 'company',
      query: 'Analytical',
      limit: 10,
    });

    expect(found).toMatchObject([
      {
        id: 'company_row',
        etag: '2026-01-01T00:00:00.000Z',
        properties: { name: 'Analytical Engines' },
      },
    ]);
    expect(decodeURIComponent(twenty.captured[0]?.url ?? '')).toContain(
      'name[ilike]:"%Analytical%"',
    );

    await expect(
      client.updateRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        field: 'domain',
        value: 'engines.example',
        ifMatch: 'stale-etag',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    expect(
      twenty.captured.filter((request) => request.method === 'PATCH'),
    ).toHaveLength(0);

    const updated = await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: 'company_row',
      field: 'domain',
      value: 'engines.example',
      ifMatch: '2026-01-01T00:00:00.000Z',
    });
    const patch = twenty.captured.find((request) => request.method === 'PATCH');

    expect(updated.etag).toBe('2026-01-02T00:00:00.000Z');
    expect(updated.properties.domain).toBe('engines.example');
    expect(decodeURIComponent(patch?.url ?? '')).toContain(
      'and(id[eq]:"company_row",updatedAt[eq]:"2026-01-01T00:00:00.000Z")',
    );
    expect(patch?.ifMatch).toBeUndefined();
    expect(patch?.body).toEqual({
      domainName: {
        primaryLinkUrl: 'https://engines.example',
        primaryLinkLabel: '',
        secondaryLinks: [],
      },
    });
    expect(JSON.stringify(patch?.body)).not.toContain('ws_demo');
  });

  it('does not request a traversed record id and reports a note delete that failed', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (captured.method === 'POST' && captured.url === '/rest/notes') {
        sendJson(response, 201, {
          data: { createNote: { id: 'note_orphan', updatedAt: 'v1' } },
        });
        return;
      }

      sendJson(response, 500, { data: {} });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await expect(
      client.deleteRecord({
        workspaceId: 'ws_demo',
        objectName: 'note',
        id: '../metadata',
      }),
    ).rejects.toThrow(/unsafe record id/);
    expect(twenty.captured).toHaveLength(0);

    await expect(
      client.createNote({
        workspaceId: 'ws_demo',
        body: 'A fictional note.',
        targetObject: 'company',
        targetId: 'company_row',
      }),
    ).rejects.toBeInstanceOf(CrmPartialWriteError);
    expect(twenty.captured.map((request) => request.url)).toEqual([
      '/rest/notes',
      '/rest/noteTargets',
      '/rest/notes/note_orphan?soft_delete=true',
    ]);
  });

  it('keeps additional emails when the primary email changes and writes nothing on a lost race', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (captured.method === 'GET') {
        sendJson(response, 200, {
          data: {
            person: {
              id: 'person_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              name: { firstName: 'Ada', lastName: 'Lovelace' },
              emails: {
                primaryEmail: 'ada@analytical.example',
                additionalEmails: ['ada.archive@analytical.example'],
              },
            },
          },
        });
        return;
      }

      sendJson(response, 200, { data: { updatePeople: [] } });
    });
    const client = createClient({
      apiUrl: twenty.url,
      style: 'rest',
    });

    await expect(
      client.updateRecord({
        workspaceId: 'ws_demo',
        objectName: 'person',
        id: 'person_row',
        field: 'email',
        value: 'ada.office@analytical.example',
        ifMatch: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);

    const patch = twenty.captured.find((request) => request.method === 'PATCH');

    expect(patch?.body).toEqual({
      emails: {
        primaryEmail: 'ada.office@analytical.example',
        additionalEmails: ['ada.archive@analytical.example'],
      },
    });
  });

  it('deletes the note link before the note', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (captured.method === 'GET') {
        sendJson(response, 200, {
          data: { noteTargets: [{ id: 'noteTarget_row' }] },
        });
        return;
      }

      sendJson(response, 200, {
        data: { deleteNoteTarget: { id: 'noteTarget_row' } },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await client.deleteRecord({
      workspaceId: 'ws_demo',
      objectName: 'note',
      id: 'note_row',
    });

    expect(twenty.captured.map((request) => request.url)).toEqual([
      '/rest/noteTargets?filter=noteId%5Beq%5D%3A%22note_row%22&limit=50',
      '/rest/noteTargets/noteTarget_row?soft_delete=true',
      '/rest/notes/note_row?soft_delete=true',
    ]);
  });

  it('still deletes the note when the link query is rejected', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (captured.method === 'GET') {
        sendJson(response, 400, { error: 'bad filter' });
        return;
      }

      sendJson(response, 200, { data: { deleteNote: { id: 'note_row' } } });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await client.deleteRecord({
      workspaceId: 'ws_demo',
      objectName: 'note',
      id: 'note_row',
    });

    expect(
      twenty.captured.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      'GET /rest/noteTargets?filter=noteId%5Beq%5D%3A%22note_row%22&limit=50',
      'DELETE /rest/notes/note_row?soft_delete=true',
    ]);
  });

  it('soft-deletes on archive, restores on undo, and writes website, city, and linkedin composites', async () => {
    let archived = false;
    const twenty = await startFakeTwenty((captured, response) => {
      if (
        captured.method === 'GET' &&
        captured.url?.startsWith('/rest/companies/')
      ) {
        if (archived) {
          sendJson(response, 404, { data: {} });
          return;
        }

        sendJson(response, 200, {
          data: {
            company: {
              id: 'company_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              name: 'Acme',
              address: { addressStreet1: '1 Old Road', addressCity: 'Porto' },
            },
          },
        });
        return;
      }

      if (captured.method === 'DELETE') {
        archived = true;
        sendJson(response, 200, {
          data: {
            deleteCompanies: [
              {
                id: 'company_row',
                updatedAt: '2026-01-03T00:00:00.000Z',
              },
            ],
          },
        });
        return;
      }

      if (captured.url?.includes('/restore')) {
        sendJson(response, 200, {
          data: { restoreCompanies: [{ id: 'company_row' }] },
        });
        return;
      }

      sendJson(response, 200, {
        data: {
          updateCompanies: [
            { id: 'company_row', updatedAt: '2026-01-02T00:00:00.000Z' },
          ],
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: 'company_row',
      field: 'city',
      value: 'Lisbon',
      ifMatch: '2026-01-01T00:00:00.000Z',
    });
    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: 'company_row',
      field: 'website',
      value: 'acme.example',
      ifMatch: '2026-01-01T00:00:00.000Z',
    });
    const archivedRecord = await client.archiveRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: 'company_row',
      ifMatch: '2026-01-01T00:00:00.000Z',
    });

    expect(archivedRecord.etag).toBe('2026-01-03T00:00:00.000Z');
    await client.restoreRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: 'company_row',
      ifMatch: archivedRecord.etag,
    });

    const patches = twenty.captured.filter(
      (request) => request.method === 'PATCH',
    );

    expect(patches[0]?.body).toEqual({
      address: {
        addressStreet1: '1 Old Road',
        addressStreet2: '',
        addressCity: 'Lisbon',
        addressState: '',
        addressPostcode: '',
        addressCountry: '',
      },
    });
    expect(patches[1]?.body).toEqual({
      domainName: {
        primaryLinkUrl: 'https://acme.example',
        primaryLinkLabel: '',
        secondaryLinks: [],
      },
    });
    expect(
      twenty.captured.map((request) => `${request.method} ${request.url}`),
    ).toEqual([
      'GET /rest/companies/company_row?depth=1',
      'PATCH /rest/companies?filter=and(id%5Beq%5D%3A%22company_row%22%2CupdatedAt%5Beq%5D%3A%222026-01-01T00%3A00%3A00.000Z%22)',
      'GET /rest/companies/company_row?depth=1',
      'PATCH /rest/companies?filter=and(id%5Beq%5D%3A%22company_row%22%2CupdatedAt%5Beq%5D%3A%222026-01-01T00%3A00%3A00.000Z%22)',
      'GET /rest/companies/company_row?depth=1',
      'DELETE /rest/companies?filter=and(id%5Beq%5D%3A%22company_row%22%2CupdatedAt%5Beq%5D%3A%222026-01-01T00%3A00%3A00.000Z%22)&soft_delete=true',
      'GET /rest/companies/company_row?depth=1',
      'PATCH /rest/companies/restore?filter=and(id%5Beq%5D%3A%22company_row%22%2CupdatedAt%5Beq%5D%3A%222026-01-03T00%3A00%3A00.000Z%22)',
    ]);
  });

  it('does not restore an archived row when If-Match has moved', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (captured.method === 'GET') {
        sendJson(response, 404, { data: {} });
        return;
      }

      sendJson(response, 200, { data: { restoreCompanies: [] } });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await expect(
      client.restoreRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        ifMatch: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    await expect(
      client.restoreRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);

    const urls = twenty.captured.map((request) => request.url ?? '');

    expect(urls.some((url) => url.includes('/company_row/restore'))).toBe(
      false,
    );
    expect(urls.filter((url) => url.includes('/restore'))).toHaveLength(1);
    expect(
      decodeURIComponent(urls.find((url) => url.includes('/restore')) ?? ''),
    ).toContain('updatedAt[eq]:"2026-01-01T00:00:00.000Z"');
  });

  it('does not restore a live row whose etag has moved', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, {
        data: {
          company: {
            id: 'company_row',
            updatedAt: '2026-01-02T00:00:00.000Z',
            name: 'Acme',
          },
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await expect(
      client.restoreRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        ifMatch: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    expect(
      twenty.captured.some((request) => request.url?.includes('/restore')),
    ).toBe(false);
  });

  it('does not delete note targets when the note If-Match no longer matches', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (
        captured.method === 'GET' &&
        captured.url?.includes('/rest/notes/note_row')
      ) {
        sendJson(response, 200, {
          data: {
            note: {
              id: 'note_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              title: 'Call',
            },
          },
        });
        return;
      }

      sendJson(response, 200, { data: { deleteNotes: [] } });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await expect(
      client.deleteRecord({
        workspaceId: 'ws_demo',
        objectName: 'note',
        id: 'note_row',
        ifMatch: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    expect(
      twenty.captured.some((request) => request.url?.includes('noteTargets')),
    ).toBe(false);
  });

  it('locks relation fields by their metadata name', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, {
        data: {
          objects: {
            edges: [
              {
                node: {
                  id: 'obj_company',
                  nameSingular: 'company',
                  fieldsList: [
                    { id: 'field_name', name: 'name' },
                    { id: 'field_domain', name: 'domainName' },
                    { id: 'field_linkedin', name: 'linkedinLink' },
                    { id: 'field_address', name: 'address' },
                    { id: 'field_owner', name: 'accountOwner' },
                  ],
                },
              },
              {
                node: {
                  id: 'obj_opportunity',
                  nameSingular: 'opportunity',
                  fieldsList: [
                    { id: 'field_opp_name', name: 'name' },
                    { id: 'field_stage', name: 'stage' },
                    { id: 'field_amount', name: 'amount' },
                    { id: 'field_close', name: 'closeDate' },
                    { id: 'field_opp_owner', name: 'owner' },
                    { id: 'field_opp_company', name: 'company' },
                    { id: 'field_poc', name: 'pointOfContact' },
                  ],
                },
              },
              {
                node: {
                  id: 'obj_person',
                  nameSingular: 'person',
                  fieldsList: [
                    { id: 'field_person_name', name: 'name' },
                    { id: 'field_emails', name: 'emails' },
                    { id: 'field_job', name: 'jobTitle' },
                    { id: 'field_phones', name: 'phones' },
                    { id: 'field_person_linkedin', name: 'linkedinLink' },
                    { id: 'field_company', name: 'company' },
                  ],
                },
              },
            ],
          },
          currentUser: {
            currentUserWorkspace: {
              objectPermissions: [
                {
                  objectMetadataId: 'obj_company',
                  canReadObjectRecords: true,
                  canUpdateObjectRecords: true,
                  canSoftDeleteObjectRecords: true,
                  restrictedFields: {
                    field_owner: { canRead: true, canUpdate: false },
                  },
                },
                {
                  objectMetadataId: 'obj_opportunity',
                  canReadObjectRecords: true,
                  canUpdateObjectRecords: true,
                  canSoftDeleteObjectRecords: true,
                  restrictedFields: {
                    field_opp_owner: { canRead: true, canUpdate: false },
                  },
                },
                {
                  objectMetadataId: 'obj_person',
                  canReadObjectRecords: true,
                  canUpdateObjectRecords: true,
                  canSoftDeleteObjectRecords: true,
                  restrictedFields: {
                    field_emails: { canRead: false, canUpdate: false },
                    field_company: { canRead: true, canUpdate: false },
                  },
                },
              ],
            },
          },
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'graphql' });

    if (!client.loadCapabilities) {
      throw new Error('loadCapabilities is missing');
    }

    const capabilities = await client.loadCapabilities();
    const company = capabilities.objects.find(
      (object) => object.objectName === 'company',
    );
    const opportunity = capabilities.objects.find(
      (object) => object.objectName === 'opportunity',
    );
    const person = capabilities.objects.find(
      (object) => object.objectName === 'person',
    );
    const companyFields = company?.fieldPermissions;
    const opportunityFields = opportunity?.fieldPermissions;
    const personFields = person?.fieldPermissions;

    expect(Array.isArray(companyFields)).toBe(true);
    expect(companyFields).toEqual(
      expect.arrayContaining([
        { name: 'accountOwner', canUpdate: false },
        { name: 'name', canUpdate: true },
        { name: 'city', canUpdate: true },
      ]),
    );
    expect(companyFields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'accountOwner', unreadable: true }),
      ]),
    );
    expect(opportunityFields).toEqual(
      expect.arrayContaining([
        { name: 'owner', canUpdate: false },
        { name: 'companyId', canUpdate: true },
        { name: 'pointOfContactId', canUpdate: true },
      ]),
    );
    expect(personFields).toEqual(
      expect.arrayContaining([
        { name: 'email', canUpdate: false },
        { name: 'companyId', canUpdate: false },
      ]),
    );
    expect(personFields).toEqual(
      expect.arrayContaining([{ name: 'jobTitle', canUpdate: true }]),
    );
  });

  it('fails closed when restrictedFields cannot be read', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, {
        data: {
          objects: {
            edges: [
              {
                node: {
                  id: 'obj_company',
                  nameSingular: 'company',
                  fieldsList: [
                    { id: 'field_name', name: 'name' },
                    { id: 'field_owner', name: 'accountOwner' },
                  ],
                },
              },
            ],
          },
          currentUser: {
            currentUserWorkspace: {
              objectPermissions: [
                {
                  objectMetadataId: 'obj_company',
                  canReadObjectRecords: true,
                  canUpdateObjectRecords: true,
                  canSoftDeleteObjectRecords: true,
                  restrictedFields: null,
                },
              ],
            },
          },
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'graphql' });

    if (!client.loadCapabilities) {
      throw new Error('loadCapabilities is missing');
    }

    const capabilities = await client.loadCapabilities();

    expect(
      capabilities.objects.find((object) => object.objectName === 'company')
        ?.fieldPermissions,
    ).toBe('unavailable');
  });

  it('does not send a chained etag to Twenty', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 500, { data: {} });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await expect(
      client.updateRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        field: 'city',
        value: 'Lisbon',
        ifMatch: 'chained',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    await expect(
      client.archiveRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        ifMatch: 'chained',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    await expect(
      client.updateRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        field: 'city',
        value: 'Lisbon',
        ifMatch: 'created',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    await expect(
      client.clearRecordField({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: 'company_row',
        field: 'city',
        ifMatch: 'created',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    expect(twenty.captured).toHaveLength(0);
  });

  it('searches note bodies, task bodies, and activity names with Twenty filters', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      const url = captured.url ?? '';

      if (url.startsWith('/rest/notes')) {
        sendJson(response, 200, {
          data: {
            notes: [
              {
                id: 'note_row',
                title: 'Call',
                updatedAt: '2026-01-01T00:00:00.000Z',
                bodyV2: { markdown: 'Discussed the fictional pilot' },
              },
            ],
          },
        });
        return;
      }

      if (url.startsWith('/rest/tasks')) {
        sendJson(response, 200, {
          data: {
            tasks: [
              {
                id: 'task_row',
                title: 'Follow up',
                updatedAt: '2026-01-01T00:00:00.000Z',
                bodyV2: { markdown: 'Send the brief' },
              },
            ],
          },
        });
        return;
      }

      sendJson(response, 200, {
        data: {
          timelineActivities: [
            {
              id: 'activity_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              linkedRecordCachedName: 'Acme Corp',
            },
          ],
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });
    const notes = await client.searchNotes({
      workspaceId: 'ws_demo',
      query: 'pilot',
      limit: 5,
    });
    const tasks = await client.searchTasks({
      workspaceId: 'ws_demo',
      query: 'brief',
      limit: 5,
    });
    const activities = await client.searchActivities({
      workspaceId: 'ws_demo',
      query: 'Acme',
      limit: 5,
    });

    expect(notes[0]).toMatchObject({
      id: 'note_row',
      label: 'Call',
      properties: { body: 'Discussed the fictional pilot' },
    });
    expect(tasks[0]?.label).toBe('Follow up');
    expect(activities[0]).toMatchObject({
      objectName: 'timelineActivity',
      label: 'Acme Corp',
    });
    expect(twenty.captured.map((entry) => entry.url)).toEqual([
      expect.stringContaining('bodyV2.markdown'),
      expect.stringContaining('/rest/tasks'),
      expect.stringContaining('linkedRecordCachedName'),
    ]);
  });

  it('scopes an open-record read and deletes only when If-Match still matches', async () => {
    const twenty = await startFakeTwenty((captured, response) => {
      if (
        captured.method === 'GET' &&
        captured.url?.includes('/rest/notes/note_row')
      ) {
        sendJson(response, 200, {
          data: {
            note: {
              id: 'note_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              title: 'Call',
            },
          },
        });
        return;
      }

      if (
        captured.method === 'GET' &&
        captured.url?.startsWith('/rest/noteTargets')
      ) {
        sendJson(response, 200, { data: { noteTargets: [] } });
        return;
      }

      if (captured.method === 'DELETE') {
        sendJson(response, 200, {
          data: { deleteNotes: [{ id: 'note_row' }] },
        });
        return;
      }

      sendJson(response, 200, {
        data: {
          notes: [
            {
              id: 'note_row',
              updatedAt: '2026-01-01T00:00:00.000Z',
              title: 'Call',
            },
          ],
        },
      });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });
    const recordId = '11111111-1111-4111-8111-111111111111';

    await client.searchNotes({
      workspaceId: 'ws_demo',
      query: 'record',
      limit: 5,
      recordId,
    });
    await client.deleteRecord({
      workspaceId: 'ws_demo',
      objectName: 'note',
      id: 'note_row',
      ifMatch: '2026-01-01T00:00:00.000Z',
    });

    expect(twenty.captured[0]?.url).toContain(encodeURIComponent(recordId));
    expect(
      twenty.captured
        .map((entry) => entry.url)
        .some((url) => url?.includes('updatedAt')),
    ).toBe(true);
  });

  it('looks up a duplicate company by domain host, not by name', async () => {
    const twenty = await startFakeTwenty((_captured, response) => {
      sendJson(response, 200, { data: { companies: [] } });
    });
    const client = createClient({ apiUrl: twenty.url, style: 'rest' });

    await client.searchRecords({
      workspaceId: 'ws_demo',
      objectName: 'company',
      query: 'acme.example',
      domainHost: 'acme.example',
      limit: 10,
    });

    const filter = decodeURIComponent(twenty.captured[0]?.url ?? '');

    expect(filter).toContain(
      'domainName.primaryLinkUrl[eq]:"https://acme.example"',
    );
    expect(filter).toContain(
      'domainName.primaryLinkUrl[eq]:"https://www.acme.example"',
    );
    expect(filter).not.toContain('name[ilike]');
    expect(filter).toContain(restDomainHostFilter('acme.example'));
    expect(graphqlDomainHostFilter('acme.example')).toEqual({
      or: [
        { domainName: { primaryLinkUrl: { eq: 'https://acme.example' } } },
        { domainName: { primaryLinkUrl: { eq: 'http://acme.example' } } },
        {
          domainName: { primaryLinkUrl: { eq: 'https://www.acme.example' } },
        },
        { domainName: { primaryLinkUrl: { eq: 'http://www.acme.example' } } },
        { domainName: { primaryLinkUrl: { eq: 'acme.example' } } },
      ],
    });

    await expect(
      client.searchRecords({
        workspaceId: 'ws_demo',
        objectName: 'company',
        query: 'acme.example',
        domainHost: 'acme.example",name[eq]:"x',
        limit: 10,
      }),
    ).rejects.toThrow(/unsafe search query/);
    expect(twenty.captured).toHaveLength(1);
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
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      ifMatch: Array.isArray(request.headers['if-match'])
        ? request.headers['if-match'][0]
        : request.headers['if-match'],
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

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
