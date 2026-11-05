import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { groundModelPlan } from './act/ground-model-plan';
import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('field permissions', () => {
  it('does not propose or execute a field the member cannot update', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.example',
    });
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canSoftDelete: true,
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
    const email = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: { object: 'person', id: person.id, field: 'email', value: 'ada@other.example', ifMatch: person.etag },
        },
      ],
    });
    const title = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: { object: 'person', id: person.id, field: 'jobTitle', value: 'Analyst', ifMatch: person.etag },
        },
      ],
    });

    const updateTool =
      isRecord(catalog) && Array.isArray(catalog.tools)
        ? catalog.tools.find((tool) => isRecord(tool) && tool.name === 'update_record')
        : undefined;
    const description = isRecord(updateTool) && typeof updateTool.description === 'string' ? updateTool.description : '';

    expect(description).not.toContain('email');
    expect(description).toContain('jobTitle');
    expect(email.payload).toMatchObject({
      refused: true,
      reason: 'forbidden',
      message: expect.stringContaining('email'),
    });
    expect(title.payload).toMatchObject({ ok: true });
    expect(person.properties.email).toBe('ada@analytical.example');
  });

  it('fails closed when field permissions cannot be read', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canSoftDelete: false,
          fieldPermissions: 'unavailable',
        },
      ],
    });
    const gateway = await openGateway(client);
    const blocked = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: { object: 'person', id: person.id, field: 'jobTitle', value: 'Analyst', ifMatch: person.etag },
        },
      ],
    });
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
            { name: 'jobTitle', canUpdate: true },
          ],
        },
      ],
    });
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: { object: 'person', id: person.id, field: 'jobTitle', value: 'Analyst', ifMatch: person.etag },
        },
      ],
    });
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canSoftDelete: false,
          fieldPermissions: 'unavailable',
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(blocked.response.status).toBe(403);
    expect(String(isRecord(blocked.payload) ? blocked.payload.message : '')).toContain('could not be read');
    expect(acted.payload).toMatchObject({ refused: true, reason: 'forbidden' });
    expect(person.properties.jobTitle).toBeUndefined();
  });
});

describe('undo stack', () => {
  it('undoes recent acts newest first and points the audit row at the act', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
    const gateway = await openGateway(client);
    const first = await confirmUpdate(gateway, company.id, 'city', 'Lisbon', company.etag);
    const current = client.created.find((record) => record.id === company.id);
    const second = await confirmUpdate(gateway, company.id, 'city', 'Porto', current?.etag ?? '');
    const firstUndo = undoIdFrom(first.payload);
    const secondUndo = undoIdFrom(second.payload);
    const skipped = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: firstUndo,
    });
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: secondUndo,
    });
    const older = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: firstUndo,
    });
    const audit = await fetch(`${gateway.url}/v1/ai/audit`, {
      headers: { 'x-rex-member': 'ada@analytical.example' },
    });
    const auditBody: unknown = await audit.json();
    const rows =
      isRecord(auditBody) && Array.isArray(auditBody.entries) ? auditBody.entries.filter(isRecord) : [];
    const actIds = new Set(rows.filter((row) => row.action === 'act' && row.ok === true).map((row) => row.id));
    const undoRows = rows.filter((row) => row.action === 'undo' && row.ok === true);

    expect(isRecord(second.payload) && Array.isArray(second.payload.undos) ? second.payload.undos.length : 0).toBe(2);
    expect(skipped.payload).toMatchObject({ refused: true, reason: 'invalid_request' });
    expect(undone.payload).toMatchObject({ ok: true, undo: { id: firstUndo } });
    expect(older.payload).toMatchObject({ ok: true });
    expect(undoRows.map((row) => row.reverses).every((id) => actIds.has(id))).toBe(true);
    expect(client.created.find((record) => record.id === company.id)?.properties.city).toBeUndefined();
  });

  it('keeps more than the last undo ticket in sqlite', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-ai-undo-stack-'));
    const filename = path.join(directory, 'state.sqlite');
    const first = openGatewayState(filename);
    const older = first.undos.save('member_ada', 'ws_demo', [
      { kind: 'created', objectName: 'company', id: 'company_older' },
    ]);
    const newer = first.undos.save('member_ada', 'ws_demo', [
      { kind: 'created', objectName: 'person', id: 'person_newer' },
    ]);
    first.undos.linkAct(newer?.id ?? '', 'member_ada', 'audit_act');
    first.close();
    const second = openGatewayState(filename);

    expect(second.undos.list('member_ada', 'ws_demo').map((ticket) => ticket.id)).toEqual([
      newer?.id,
      older?.id,
    ]);
    expect(second.undos.peek(older?.id ?? '', 'member_ada', 'ws_demo')).toMatchObject({
      ok: false,
      reason: 'order',
    });
    expect(second.undos.peek(newer?.id ?? '', 'member_ada', 'ws_demo')).toMatchObject({
      ok: true,
      ticket: { actAuditId: 'audit_act' },
    });
    second.close();
  });
});

describe('disambiguation inside one plan', () => {
  it('asks for both names in one preview and writes both choices', async () => {
    const client = createMockTwentyCrmClient();
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada.north@analytical.example',
    });
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada.south@analytical.example',
    });
    await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: 'Lisbon' });
    await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme', city: 'Porto' });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent:
        'update person named Ada Lovelace set jobTitle to Analyst and update company named Acme set city to Faro',
    });
    const groups =
      isRecord(planned.payload) &&
      isRecord(planned.payload.proposal) &&
      isRecord(planned.payload.proposal.choice) &&
      Array.isArray(planned.payload.proposal.choice.groups)
        ? planned.payload.proposal.choice.groups
        : [];
    const personGroup = groups.find((group) => isRecord(group) && String(group.prompt).includes('people'));
    const companyGroup = groups.find((group) => isRecord(group) && String(group.prompt).includes('companies'));
    const personId = candidateId(personGroup, 'ada.north@analytical.example');
    const companyId = candidateId(companyGroup, 'Porto');
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
      choices: {
        [String(isRecord(personGroup) ? personGroup.id : '')]: personId,
        [String(isRecord(companyGroup) ? companyGroup.id : '')]: companyId,
      },
    });

    expect(groups).toHaveLength(2);
    expect(acted.response.status).toBe(200);
    expect(client.created.find((record) => record.id === personId)?.properties.jobTitle).toBe('Analyst');
    expect(client.created.find((record) => record.id === companyId)?.properties.city).toBe('Faro');
    expect(client.created.filter((record) => record.properties.jobTitle === 'Analyst')).toHaveLength(1);
  });
});

describe('several fields on one record', () => {
  it('refreshes If-Match between writes in one preview', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      intent:
        'update person named Ada Lovelace set email to ada@analytical.example and jobTitle to Analyst',
    });
    const tools =
      isRecord(planned.payload) && isRecord(planned.payload.proposal) && Array.isArray(planned.payload.proposal.tools)
        ? planned.payload.proposal.tools
        : [];
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const stored = client.created.find((record) => record.id === person.id);

    expect(planned.payload).toMatchObject({ ok: true });
    expect(JSON.stringify(tools)).toContain('chained');
    expect(acted.response.status).toBe(200);
    expect(stored?.properties.email).toBe('ada@analytical.example');
    expect(stored?.properties.jobTitle).toBe('Analyst');
    expect(stored?.etag).toBe('v3');
  });
});

describe('archive and record ids', () => {
  it('refuses to undo an archive without soft-delete permission', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({ workspaceId: 'ws_demo', name: 'Acme' });
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
    client.loadCapabilities = async () => ({
      objects: [
        { objectName: 'company', canRead: true, canUpdate: true, canSoftDelete: false },
      ],
    });
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: undoIdFrom(acted.payload),
    });

    expect(acted.response.status).toBe(200);
    expect(undone.payload).toMatchObject({
      refused: true,
      reason: 'forbidden',
      message: expect.stringContaining('archive'),
    });
  });

  it('accepts a UUID the member typed and rejects a long non-uuid token', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const accepted = groundModelPlan(
      [{ name: 'update_record', args: { id: uuid, field: 'jobTitle', value: 'Analyst', object: 'person' } }],
      `update person ${uuid} set jobTitle to Analyst`,
      [],
    );
    const rejected = groundModelPlan(
      [
        {
          name: 'update_record',
          args: { id: 'analytical', field: 'jobTitle', value: 'Analyst', object: 'person' },
        },
      ],
      'update person analytical set jobTitle to Analyst',
      [],
    );

    expect(accepted).toEqual([
      {
        name: 'update_record',
        args: { id: uuid, field: 'jobTitle', value: 'Analyst', object: 'person' },
      },
    ]);
    expect(rejected).toMatchObject({ refused: true, reason: 'invalid_request' });
  });
});

async function confirmUpdate(
  gateway: RunningGateway,
  id: string,
  field: string,
  value: string,
  ifMatch: string,
): Promise<{ payload: unknown; summary: string | undefined }> {
  const planned = await postJson(gateway, '/v1/ai/plan', {
    workspaceId: 'ws_demo',
    tools: [{ name: 'update_record', args: { object: 'company', id, field, value, ifMatch } }],
  });
  const summary =
    isRecord(planned.payload) && isRecord(planned.payload.proposal) && typeof planned.payload.proposal.summary === 'string'
      ? planned.payload.proposal.summary
      : undefined;
  const acted = await postJson(gateway, '/v1/ai/act', {
    workspaceId: 'ws_demo',
    confirmed: true,
    proposalId: proposalId(planned.payload),
  });

  return { payload: acted.payload, summary };
}

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

function candidateId(group: unknown, detail: string): string {
  if (!isRecord(group) || !Array.isArray(group.candidates)) {
    throw new Error('Missing choice group');
  }

  const candidate = group.candidates.find(
    (item) => isRecord(item) && (item.detail === detail || String(item.label).includes(detail) || String(item.detail).includes(detail)),
  );

  if (!isRecord(candidate) || typeof candidate.id !== 'string') {
    throw new Error(`Missing candidate ${detail}`);
  }

  return candidate.id;
}
