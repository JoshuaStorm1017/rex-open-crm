import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { CrmPreconditionError } from './twenty/crm-errors';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('live etag on confirm', () => {
  it('shows current against proposed and blocks confirm when the row moved', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: `update company ${company.id} set city to Faro`,
    });
    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: company.id,
      field: 'city',
      value: 'Porto',
      ifMatch: company.etag,
    });
    const blocked = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const blockedAgain = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(planned.payload).toMatchObject({
      ok: true,
      proposal: {
        changes: [
          {
            field: 'city',
            metadataField: 'address',
            current: 'Lisbon',
            proposed: 'Faro',
            summary: 'Current city “Lisbon”. Proposed “Faro”.',
          },
        ],
      },
    });
    expect(blocked.response.status).toBe(412);
    expect(blocked.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
      message: expect.stringContaining('Confirm is blocked'),
      stale: [{ field: 'city', current: 'Porto', proposed: 'Faro' }],
    });
    expect(blockedAgain.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
    });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Porto');
  });
});

describe('read-only answers', () => {
  it('answers notes, tasks, and activities on the open record without confirm', async () => {
    const client = createMockTwentyCrmClient();
    const deal = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Acme deal',
      stage: 'NEW',
    });
    const other = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Grace',
      lastName: 'Hopper',
    });
    await client.createNote({
      workspaceId: 'ws_demo',
      title: 'Buyer call',
      body: 'Talked about the pilot',
      targetObject: 'opportunity',
      targetId: deal.id,
    });
    await client.createNote({
      workspaceId: 'ws_demo',
      title: 'Other note',
      body: 'Unrelated',
      targetObject: 'person',
      targetId: other.id,
    });
    client.created.push({
      id: 'task_deal',
      objectName: 'task',
      workspaceId: 'ws_demo',
      properties: { title: 'Send proposal', body: 'Draft', targetId: deal.id },
      etag: 'v1',
      label: 'Send proposal',
    });
    client.created.push({
      id: 'activity_deal',
      objectName: 'timelineActivity',
      workspaceId: 'ws_demo',
      properties: { name: 'Acme deal', linkedRecordId: deal.id },
      etag: 'v1',
      label: 'Acme deal',
    });
    const gateway = await openGateway(client);
    const before = client.created.length;
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'what happened with this deal',
      context: { objectName: 'opportunity', recordId: deal.id },
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
    });

    expect(planned.payload).toMatchObject({ ok: true });
    expect(planned.payload).not.toHaveProperty('proposal');
    const labels = answerLabels(planned.payload);
    expect(labels).toEqual(
      expect.arrayContaining(['Buyer call', 'Send proposal', 'Acme deal']),
    );
    expect(labels).not.toContain('Other note');
    expect(acted.payload).toMatchObject({
      refused: true,
      reason: 'confirmation_required',
    });
    expect(client.created).toHaveLength(before);
  });

  it('answers a read in a mixed plan and still requires confirm for the write', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    await client.createNote({
      workspaceId: 'ws_demo',
      title: 'Call',
      body: 'Discussed the fictional pilot',
      targetObject: 'company',
      targetId: company.id,
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        { name: 'search_notes', args: { query: 'pilot' } },
        {
          name: 'update_record',
          args: {
            object: 'company',
            id: company.id,
            field: 'city',
            value: 'Faro',
          },
        },
      ],
    });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Lisbon');
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(answerLabels(planned.payload)).toContain('Call');
    expect(planned.payload).toMatchObject({
      proposal: { tools: [{ name: 'update_record' }] },
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Faro');
  });
});

describe('bulk progress', () => {
  it('streams each settled row and keeps one undo for the act', async () => {
    const client = createMockTwentyCrmClient();
    const first = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    const second = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Porto',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update all companies named Acme set city to Faro',
    });
    const response = await fetch(`${gateway.url}/v1/ai/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-rex-member': 'ada@analytical.example',
        'idempotency-key': 'bulk-faro-1',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(planned.payload),
      }),
    });
    const text = await response.text();
    const progress = sseEvents(text).filter(
      (event) => event.name === 'progress',
    );
    const result = sseEvents(text).find(
      (event) => event.name === 'result',
    )?.data;

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(progress.map((event) => event.data)).toEqual([
      expect.objectContaining({
        index: 1,
        total: 2,
        status: 'updated',
        id: first.id,
      }),
      expect.objectContaining({
        index: 2,
        total: 2,
        status: 'updated',
        id: second.id,
      }),
    ]);
    expect(result).toMatchObject({
      ok: true,
      undo: { summary: expect.stringContaining('2 field changes') },
    });
    expect(
      isRecord(result) && Array.isArray(result.undos) ? result.undos : [],
    ).toHaveLength(1);
    expect(
      client.created.find((record) => record.id === first.id)?.properties.city,
    ).toBe('Faro');
    expect(
      client.created.find((record) => record.id === second.id)?.properties.city,
    ).toBe('Faro');
  });
});

describe('preview warnings', () => {
  it('warns on a duplicate email and still creates when confirmed', async () => {
    const client = createMockTwentyCrmClient();
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: {
            firstName: 'Augusta',
            lastName: 'King',
            email: 'ada@analytical.example',
          },
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(planned.payload).toMatchObject({
      proposal: {
        warnings: [
          {
            code: 'duplicate_email',
            message: expect.stringContaining('ada@analytical.example'),
          },
        ],
      },
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.filter(
        (record) => record.properties.email === 'ada@analytical.example',
      ),
    ).toHaveLength(2);
  });

  it('warns when an opportunity amount does not match the company and still writes it', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
    });
    await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Acme renewal',
      stage: 'NEW',
      amount: 10000,
      companyId: company.id,
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: {
            name: 'Acme expansion',
            amount: 50000,
            companyId: company.id,
          },
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(planned.payload).toMatchObject({
      proposal: {
        warnings: [
          {
            code: 'amount_mismatch',
            message: expect.stringContaining('Acme renewal'),
          },
        ],
      },
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.some((record) => record.properties.amount === 50000),
    ).toBe(true);
  });
});

describe('review polish', () => {
  it('hides a partial tool the role cannot run', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canCreate: true,
          canSoftDelete: false,
        },
        {
          objectName: 'company',
          canRead: true,
          canUpdate: true,
          canCreate: false,
          canSoftDelete: false,
        },
        {
          objectName: 'opportunity',
          canRead: true,
          canUpdate: true,
          canCreate: true,
          canSoftDelete: false,
        },
      ],
    });
    const gateway = await openGateway(client);
    const response = await fetch(`${gateway.url}/v1/ai/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        intent: 'add Acme Corp as a company and a $50k deal for Jane Doe',
      }),
    });
    const text = await response.text();
    const partial = text.slice(0, text.indexOf('event: error'));

    expect(partial).toContain('Planning create_person');
    expect(partial).not.toContain('create_company');
    expect(text).toContain('"reason":"forbidden"');
    expect(client.created).toHaveLength(0);
  });

  it('refuses delete and restore when If-Match does not match', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'person',
      id: person.id,
      field: 'jobTitle',
      value: 'Analyst',
      ifMatch: person.etag,
    });

    await expect(
      client.deleteRecord({
        workspaceId: 'ws_demo',
        objectName: 'person',
        id: person.id,
        ifMatch: person.etag,
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    expect(client.created.some((record) => record.id === person.id)).toBe(true);

    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
    });
    await client.archiveRecord({
      workspaceId: 'ws_demo',
      objectName: 'company',
      id: company.id,
      ifMatch: company.etag,
    });
    const stored = client.created.find((record) => record.id === company.id);

    if (stored) {
      stored.etag = 'v9';
    }

    await expect(
      client.restoreRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: company.id,
        ifMatch: 'v2',
      }),
    ).rejects.toBeInstanceOf(CrmPreconditionError);
    await expect(
      client.getRecord({
        workspaceId: 'ws_demo',
        objectName: 'company',
        id: company.id,
      }),
    ).rejects.toThrow(/No company/);
  });

  it('shares the undo generation across two state files in one process', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-undo-'));
    const file = path.join(dir, 'state.sqlite');
    const first = openGatewayState(file);
    const second = openGatewayState(file);
    closers.push(async () => {
      first.close();
      second.close();
    });
    const effect = {
      kind: 'created' as const,
      objectName: 'person' as const,
      id: 'person_1',
      etag: 'v1',
    };
    const ticket = first.undos.save('member_ada', 'ws_demo', [effect]);
    const begun = first.undos.begin(ticket?.id ?? '', 'member_ada', 'ws_demo');
    second.undos.save('member_ada', 'ws_demo', [effect]);

    expect(begun.ok).toBe(true);
    expect(first.undos.superseded('member_ada')).toBe(true);
  });
});

async function openGateway(client: TwentyCrmClient): Promise<RunningGateway> {
  const gateway = await startGateway({ port: 0, client });
  closers.push(() => gateway.close());
  return gateway;
}

async function postJson(
  gateway: RunningGateway,
  pathName: string,
  body: unknown,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${gateway.url}${pathName}`, {
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
  if (
    isRecord(payload) &&
    isRecord(payload.proposal) &&
    typeof payload.proposal.id === 'string'
  ) {
    return payload.proposal.id;
  }

  throw new Error('Missing proposal id');
}

function answerLabels(payload: unknown): string[] {
  if (
    !isRecord(payload) ||
    !isRecord(payload.answer) ||
    !Array.isArray(payload.answer.records)
  ) {
    return [];
  }

  return payload.answer.records.flatMap((record) =>
    isRecord(record) && typeof record.label === 'string' ? [record.label] : [],
  );
}

function sseEvents(text: string): Array<{ name: string; data: unknown }> {
  return text
    .split('\n\n')
    .map((chunk) => {
      const name = chunk
        .split('\n')
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim();
      const dataLine = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');

      if (!name || dataLine.length === 0) {
        return undefined;
      }

      return { name, data: JSON.parse(dataLine) as unknown };
    })
    .filter(
      (event): event is { name: string; data: unknown } => event !== undefined,
    );
}
