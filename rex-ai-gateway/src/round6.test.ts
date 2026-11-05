import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { createMockTwentyCrmClient, type MockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import type { CreatedRecord, TwentyCrmClient } from './twenty/twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('field locks on create', () => {
  it('refuses a restricted field and still allows a create that does not set it', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canSoftDelete: false,
          fieldPermissions: [
            { name: 'firstName', canUpdate: true },
            { name: 'lastName', canUpdate: true },
            { name: 'email', canUpdate: false },
            { name: 'jobTitle', canUpdate: true },
            { name: 'phone', canUpdate: true },
            { name: 'linkedin', canUpdate: true },
          ],
        },
      ],
    });
    const gateway = await openGateway(client);
    const tools = await fetch(`${gateway.url}/v1/ai/tools`, {
      headers: { 'x-rex-member': 'ada@analytical.example' },
    });
    const catalog: unknown = await tools.json();
    const createTool = findTool(catalog, 'create_person');
    const properties =
      isRecord(createTool) && isRecord(createTool.inputSchema) && isRecord(createTool.inputSchema.properties)
        ? createTool.inputSchema.properties
        : {};
    const blocked = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.example' },
        },
      ],
    });
    const allowed = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } }],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(allowed.payload),
    });

    expect(properties).not.toHaveProperty('email');
    expect(blocked.payload).toMatchObject({
      refused: true,
      reason: 'forbidden',
      message: expect.stringContaining('email'),
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(client.created.some((record) => record.properties.email === 'ada@analytical.example')).toBe(false);
    expect(client.created.some((record) => record.properties.firstName === 'Ada')).toBe(true);
  });

  it('fails closed when create field permissions cannot be read', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canSoftDelete: false,
          fieldPermissions: 'unavailable',
        },
        {
          objectName: 'opportunity',
          canRead: true,
          canUpdate: true,
          canSoftDelete: false,
          fieldPermissions: [
            { name: 'name', canUpdate: true },
            { name: 'stage', canUpdate: false },
            { name: 'amount', canUpdate: true },
            { name: 'closeDate', canUpdate: true },
          ],
        },
      ],
    });
    const gateway = await openGateway(client);
    const person = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_person', args: { firstName: 'Ada', lastName: 'Lovelace' } }],
    });
    const deal = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'create_opportunity', args: { name: 'Pilot', stage: 'NEW' } }],
    });
    const catalog: unknown = await (
      await fetch(`${gateway.url}/v1/ai/tools`, { headers: { 'x-rex-member': 'ada@analytical.example' } })
    ).json();

    expect(person.response.status).toBe(403);
    expect(String(isRecord(person.payload) ? person.payload.message : '')).toContain('could not be read');
    expect(deal.payload).toMatchObject({ refused: true, reason: 'forbidden', message: expect.stringContaining('stage') });
    expect(toolNames(catalog)).not.toContain('create_person');
    expect(toolNames(catalog)).not.toContain('create_opportunity');
    expect(client.created).toHaveLength(0);
  });
});

describe('streaming preview', () => {
  it('streams partial tool calls and only the final event can be confirmed', async () => {
    const client = createMockTwentyCrmClient();
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
    const partial = text.slice(0, text.indexOf('event: proposal'));
    const proposal = proposalId(eventData(text, 'proposal'));
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposal,
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(partial).toContain('event: partial');
    expect(partial).toContain('Planning create_company');
    expect(partial).not.toContain('proposal_');
    expect(acted.payload).toMatchObject({ ok: true });
    expect(client.created.map((record) => record.objectName)).toEqual(['company', 'person', 'opportunity']);
  });
});

describe('timeline search', () => {
  it('previews note, task, and activity search and runs it only after confirm', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await client.createNote({
      workspaceId: 'ws_demo',
      title: 'Call',
      body: 'Discussed the fictional pilot',
      targetObject: 'person',
      targetId: person.id,
    });
    client.created.push(record('task', 'task_follow', 'Follow up', { title: 'Follow up', body: 'Send the brief' }));
    client.created.push(
      record('timelineActivity', 'activity_acme', 'Acme Corp', { name: 'Acme Corp' }),
    );
    let searches = 0;
    const gateway = await openGateway(countingClient(client, () => {
      searches += 1;
    }));
    const notes = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'find notes about pilot',
    });
    expect(searches).toBe(0);
    const noteAct = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(notes.payload),
    });
    const tasks = await confirmIntent(gateway, 'find tasks containing brief');
    const activities = await confirmIntent(gateway, 'find activities linked to Acme');

    expect(notes.payload).toMatchObject({
      ok: true,
      proposal: { lines: [expect.objectContaining({ tool: 'search_notes' })] },
    });
    expect(noteAct.payload).toMatchObject({
      ok: true,
      results: [expect.objectContaining({ tool: 'search_notes', status: 'found' })],
    });
    expect(JSON.stringify(tasks.payload)).toContain('Follow up');
    expect(JSON.stringify(activities.payload)).toContain('Acme Corp');
    expect(searches).toBe(3);
  });

  it('hides timeline search the member cannot read', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        { objectName: 'person', canRead: true, canUpdate: false, canSoftDelete: false },
        { objectName: 'note', canRead: false, canUpdate: false, canSoftDelete: false },
        { objectName: 'task', canRead: false, canUpdate: false, canSoftDelete: false },
        { objectName: 'timelineActivity', canRead: false, canUpdate: false, canSoftDelete: false },
      ],
    });
    const gateway = await openGateway(client);
    const catalog: unknown = await (
      await fetch(`${gateway.url}/v1/ai/tools`, { headers: { 'x-rex-member': 'ada@analytical.example' } })
    ).json();
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [{ name: 'search_notes', args: { query: 'pilot' } }],
    });

    expect(toolNames(catalog)).not.toContain('search_notes');
    expect(toolNames(catalog)).not.toContain('search_tasks');
    expect(toolNames(catalog)).not.toContain('search_activities');
    expect(planned.payload).toMatchObject({ refused: true, reason: 'forbidden' });
  });
});

describe('bulk updates', () => {
  it('lists every matching record and writes each one only after confirm', async () => {
    const client = createMockTwentyCrmClient();
    const first = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: 'Lisbon' });
    const second = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: 'Porto' });
    const other = await client.createCompany({ workspaceId: 'ws_demo', name: 'Other', city: 'Paris' });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update all companies named Acme set city to Faro',
    });
    const lines = proposalLines(planned.payload);
    expect(client.created.find((record) => record.id === first.id)?.properties.city).toBe('Lisbon');
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining(first.id),
        expect.stringContaining(second.id),
        expect.stringContaining('city'),
        expect.stringContaining('Faro'),
      ]),
    );
    expect(acted.payload).toMatchObject({ ok: true });
    expect(client.created.find((record) => record.id === first.id)?.properties.city).toBe('Faro');
    expect(client.created.find((record) => record.id === second.id)?.properties.city).toBe('Faro');
    expect(client.created.find((record) => record.id === other.id)?.properties.city).toBe('Paris');
  });

  it('refuses a match wider than the preview cap and writes nothing', async () => {
    const client = createMockTwentyCrmClient();

    for (let index = 0; index < 9; index += 1) {
      await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: `City${index}` });
    }

    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent: 'update all companies named Acme set city to Faro',
    });

    expect(planned.payload).toMatchObject({
      refused: true,
      reason: 'invalid_request',
      message: expect.stringContaining('Nothing was written'),
    });
    expect(client.created.some((record) => record.properties.city === 'Faro')).toBe(false);
  });
});

describe('undo race and chained archive', () => {
  it('does not finish an undo after a newer act lands mid-flight', async () => {
    const base = createMockTwentyCrmClient();
    const person = await base.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    let gateway: RunningGateway | undefined;
    let armed = false;
    const client = wrapGetRecord(base, async () => {
      if (!armed || !gateway) {
        return;
      }

      armed = false;
      const planned = await postJson(gateway, '/v1/ai/plan', {
        workspaceId: 'ws_demo',
        tools: [
          {
            name: 'update_record',
            args: {
              object: 'person',
              id: person.id,
              field: 'jobTitle',
              value: 'Manager',
              ifMatch: base.created.find((record) => record.id === person.id)?.etag,
            },
          },
        ],
      });
      await postJson(gateway, '/v1/ai/act', {
        workspaceId: 'ws_demo',
        confirmed: true,
        proposalId: proposalId(planned.payload),
      });
    });
    gateway = await openGateway(client);
    const first = await confirmTool(gateway, {
      name: 'update_record',
      args: {
        object: 'person',
        id: person.id,
        field: 'jobTitle',
        value: 'Analyst',
        ifMatch: person.etag,
      },
    });
    armed = true;
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: undoIdFrom(first.payload),
    });

    expect(undone.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
      message: expect.stringContaining('newer change'),
    });
    expect(base.created.find((record) => record.id === person.id)?.properties.jobTitle).toBe('Manager');
  });

  it('refuses a write chained after an archive and restores the archive', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: 'Lisbon' });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'archive_record',
          args: { object: 'company', id: company.id, ifMatch: company.etag },
        },
        {
          name: 'update_record',
          args: { object: 'company', id: company.id, field: 'city', value: 'Faro', ifMatch: company.etag },
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const current = client.created.find((record) => record.id === company.id);

    expect(planned.payload).toMatchObject({ ok: true });
    expect(JSON.stringify(planned.payload)).toContain('chained');
    expect(acted.payload).toMatchObject({ refused: true, reason: 'precondition_failed' });
    expect(current?.properties.city).toBe('Lisbon');
    expect(await client.getRecord({ workspaceId: 'ws_demo', objectName: 'company', id: company.id })).toMatchObject({
      id: company.id,
    });
  });

  it('marks a sqlite undo stale when a newer act is saved mid-undo', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-ai-undo-race-'));
    const state = openGatewayState(path.join(directory, 'state.sqlite'));
    const first = state.undos.save('member_ada', 'ws_demo', [
      { kind: 'updated', objectName: 'person', id: 'person_1', field: 'jobTitle', previous: null, etag: 'v1' },
    ]);
    state.undos.begin(first?.id ?? '', 'member_ada', 'ws_demo');
    state.undos.save('member_ada', 'ws_demo', [
      { kind: 'updated', objectName: 'person', id: 'person_1', field: 'jobTitle', previous: 'Analyst', etag: 'v2' },
    ]);

    expect(state.undos.superseded('member_ada')).toBe(true);
    state.close();
  });
});

async function openGateway(client: TwentyCrmClient): Promise<RunningGateway> {
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

async function confirmIntent(gateway: RunningGateway, intent: string) {
  const planned = await postJson(gateway, '/v1/ai/plan', { workspaceId: 'ws_demo', intent });

  return postJson(gateway, '/v1/ai/act', {
    workspaceId: 'ws_demo',
    confirmed: true,
    proposalId: proposalId(planned.payload),
  });
}

async function confirmTool(gateway: RunningGateway, tool: { name: string; args: Record<string, unknown> }) {
  const planned = await postJson(gateway, '/v1/ai/plan', {
    workspaceId: 'ws_demo',
    tools: [tool],
  });

  return postJson(gateway, '/v1/ai/act', {
    workspaceId: 'ws_demo',
    confirmed: true,
    proposalId: proposalId(planned.payload),
  });
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

function proposalLines(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.proposal) || !Array.isArray(payload.proposal.lines)) {
    return [];
  }

  return payload.proposal.lines.flatMap((line) => (isRecord(line) && typeof line.summary === 'string' ? [line.summary] : []));
}

function toolNames(catalog: unknown): string[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.tools)) {
    return [];
  }

  return catalog.tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []));
}

function findTool(catalog: unknown, name: string): unknown {
  if (!isRecord(catalog) || !Array.isArray(catalog.tools)) {
    return undefined;
  }

  return catalog.tools.find((tool) => isRecord(tool) && tool.name === name);
}

function eventData(text: string, event: string): unknown {
  const marker = `event: ${event}\n`;
  const start = text.indexOf(marker);

  if (start < 0) {
    throw new Error(`Missing ${event} event`);
  }

  const dataLine = text.slice(start).split('\n').find((line) => line.startsWith('data:'));

  if (!dataLine) {
    throw new Error(`Missing ${event} data`);
  }

  return JSON.parse(dataLine.slice('data:'.length).trim());
}

function record(
  objectName: CreatedRecord['objectName'],
  id: string,
  label: string,
  properties: Record<string, string>,
): CreatedRecord {
  return {
    id,
    objectName,
    workspaceId: 'ws_demo',
    properties,
    etag: 'v1',
    label,
  };
}

function countingClient(client: MockTwentyCrmClient, onSearch: () => void): TwentyCrmClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'searchNotes' || property === 'searchTasks' || property === 'searchActivities') {
        return async (input: unknown) => {
          onSearch();
          const method = Reflect.get(target, property, receiver) as (value: unknown) => Promise<unknown>;

          return method.call(target, input);
        };
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapGetRecord(client: MockTwentyCrmClient, onGet: () => Promise<void>): TwentyCrmClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'getRecord') {
        return async (input: unknown) => {
          await onGet();
          const method = Reflect.get(target, property, receiver) as (value: unknown) => Promise<unknown>;

          return method.call(target, input);
        };
      }

      const value = Reflect.get(target, property, receiver);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
