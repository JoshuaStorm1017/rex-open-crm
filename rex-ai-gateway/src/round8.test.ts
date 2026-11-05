import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from './is-record';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';
import type { LlmProvider } from './llm/llm-provider';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

const CARD = `Ada Lovelace
Analyst
Analytical Engines
ada@analytical.example
+1 4155550134
https://www.linkedin.com/in/ada
analytical.example
12 Analytical Way
Lisbon`;

const VOICE =
  'person Ada Lovelace job Analyst at Analytical Engines email ada@analytical.example phone +1 4155550134 domain analytical.example address 12 Analytical Way city Lisbon';

const VCARD = `BEGIN:VCARD
VERSION:3.0
N:Lovelace;Ada;;;
FN:Ada Lovelace
ORG:Analytical Engines
TITLE:Analyst
EMAIL:ada@analytical.example
TEL:+14155550134
URL:https://www.linkedin.com/in/ada
ADR:;;12 Analytical Way;Lisbon;;;
END:VCARD`;

describe('reload a blocked preview', () => {
  it('loads the live etag into a new preview and still requires confirm', async () => {
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
    const cityBeforeConfirm = client.created.find(
      (record) => record.id === company.id,
    )?.properties.city;
    const reloaded = await postJson(gateway, '/v1/ai/repropose', {
      workspaceId: 'ws_demo',
      proposalId: proposalId(planned.payload),
    });
    const stillBlocked = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(reloaded.payload),
    });

    expect(blocked.response.status).toBe(412);
    expect(reloaded.payload).toMatchObject({
      ok: true,
      proposal: {
        changes: [{ field: 'city', current: 'Porto', proposed: 'Faro' }],
      },
    });
    expect(proposalId(reloaded.payload)).not.toBe(proposalId(planned.payload));
    expect(stillBlocked.response.status).toBe(412);
    expect(cityBeforeConfirm).toBe('Porto');
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Faro');
  });
});

describe('saved skills', () => {
  it('stores the confirmed tools and runs them only after confirm', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    const llm: LlmProvider = {
      async plan() {
        throw new Error('model should not run');
      },
    };
    const gateway = await openGateway(client, llm);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
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
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const confirmedPlanId = confirmedId(acted.payload);
    const etagAfterAct = client.created.find(
      (record) => record.id === company.id,
    )?.etag;
    const saved = await postJson(gateway, '/v1/ai/skills', {
      workspaceId: 'ws_demo',
      skillName: 'Move Acme',
      confirmedPlanId,
    });
    const listed = await fetch(
      `${gateway.url}/v1/ai/skills?workspaceId=ws_demo`,
      { headers: { 'x-rex-member': 'ada@analytical.example' } },
    );
    const listBody: unknown = await listed.json();
    const skill = skillId(saved.payload);
    const preview = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
    });
    const etagDuringPreview = client.created.find(
      (record) => record.id === company.id,
    )?.etag;
    const hidden = await fetch(
      `${gateway.url}/v1/ai/skills?workspaceId=ws_demo`,
      {
        headers: { 'x-rex-member': 'grace@analytical.example' },
      },
    );
    const hiddenBody: unknown = await hidden.json();
    const foreign = await postJson(
      gateway,
      '/v1/ai/plan',
      { workspaceId: 'ws_demo', skillId: skill },
      'grace@analytical.example',
    );
    const rerun = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(preview.payload),
    });

    expect(saved.payload).toMatchObject({
      ok: true,
      skill: { name: 'Move Acme', tools: ['update_record'] },
    });
    expect(saved.payload).not.toHaveProperty('proposal');
    expect(JSON.stringify(listBody)).not.toContain('Faro');
    expect(listBody).toMatchObject({
      skills: [{ name: 'Move Acme', tools: ['update_record'] }],
    });
    expect(preview.payload).toMatchObject({
      ok: true,
      proposal: {
        tools: [
          {
            name: 'update_record',
            args: { field: 'city', value: 'Faro', ifMatch: etagAfterAct },
          },
        ],
      },
    });
    expect(etagDuringPreview).toBe(etagAfterAct);
    expect(hiddenBody).toMatchObject({ skills: [] });
    expect(foreign.payload).toMatchObject({ reason: 'not_found' });
    expect(rerun.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === company.id)?.etag,
    ).not.toBe(etagAfterAct);
  });

  it('keeps a skill in the shared state file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-skill-'));
    const file = path.join(dir, 'state.sqlite');
    const first = openGatewayState(file);
    const saved = first.skills.saveSkill('member_ada', 'ws_demo', 'Move Acme', [
      {
        name: 'update_record',
        args: {
          object: 'company',
          id: 'company_1',
          field: 'city',
          value: 'Faro',
        },
      },
    ]);
    first.close();
    const second = openGatewayState(file);
    closers.push(async () => second.close());

    expect(saved.ok).toBe(true);
    expect(second.skills.list('member_ada', 'ws_demo')).toEqual([
      {
        id: saved.ok ? saved.skill.id : '',
        name: 'Move Acme',
        tools: ['update_record'],
      },
    ]);
  });
});

describe('card and voice capture', () => {
  it('turns a card, a vCard, and a dictation into the same create preview', async () => {
    const client = createMockTwentyCrmClient();
    const llm: LlmProvider = {
      async plan() {
        throw new Error('model should not run');
      },
    };
    const gateway = await openGateway(client, llm);
    const before = client.created.length;

    for (const capture of [
      { source: 'card', text: CARD },
      { source: 'card', text: VCARD },
      { source: 'voice', text: VOICE },
    ]) {
      const planned = await postJson(gateway, '/v1/ai/plan', {
        workspaceId: 'ws_demo',
        capture,
      });

      expect(planned.payload).toMatchObject({
        ok: true,
        proposal: {
          tools: [
            {
              name: 'create_company',
              args: {
                name: 'Analytical Engines',
                domain: 'analytical.example',
                address: '12 Analytical Way',
                city: 'Lisbon',
              },
            },
            {
              name: 'create_person',
              args: {
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: 'ada@analytical.example',
                jobTitle: 'Analyst',
                companyId: '$0',
              },
            },
          ],
        },
      });
      expect(client.created).toHaveLength(before);
    }

    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: { source: 'voice', text: VOICE },
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.some(
        (record) =>
          record.objectName === 'person' &&
          record.properties.email === 'ada@analytical.example',
      ),
    ).toBe(true);
    expect(
      client.created.some(
        (record) =>
          record.objectName === 'company' &&
          record.properties.name === 'Analytical Engines',
      ),
    ).toBe(true);
  });

  it('drops a field the role cannot write and still proposes the rest', async () => {
    const client = createMockTwentyCrmClient();
    client.loadCapabilities = async () => ({
      objects: [
        {
          objectName: 'person',
          canRead: true,
          canUpdate: true,
          canCreate: true,
          canSoftDelete: false,
          fieldPermissions: [
            { name: 'firstName', canUpdate: true },
            { name: 'lastName', canUpdate: true },
            { name: 'email', canUpdate: false },
            { name: 'jobTitle', canUpdate: true },
            { name: 'phone', canUpdate: true },
            { name: 'linkedin', canUpdate: true },
            { name: 'companyId', canUpdate: true },
          ],
        },
        {
          objectName: 'company',
          canRead: true,
          canUpdate: true,
          canCreate: true,
          canSoftDelete: false,
          fieldPermissions: [
            { name: 'name', canUpdate: true },
            { name: 'domain', canUpdate: true },
            { name: 'address', canUpdate: true },
            { name: 'city', canUpdate: false },
          ],
        },
      ],
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: { source: 'voice', text: VOICE },
    });
    const person = toolArgs(planned.payload, 'create_person');
    const company = toolArgs(planned.payload, 'create_company');

    expect(person).not.toHaveProperty('email');
    expect(person).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(company).not.toHaveProperty('city');
    expect(company).toMatchObject({ name: 'Analytical Engines' });
  });
});

describe('duplicate name at the same company', () => {
  it('warns and still writes the proposed person', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
    });
    await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      companyId: company.id,
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada.other@analytical.example',
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
        tools: [
          {
            name: 'create_person',
            args: {
              firstName: 'Ada',
              lastName: 'Lovelace',
              companyId: company.id,
            },
          },
        ],
        warnings: [
          {
            code: 'duplicate_name',
            message: expect.stringContaining('already linked to Acme'),
          },
        ],
      },
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.filter(
        (record) =>
          record.objectName === 'person' &&
          record.properties.lastName === 'Lovelace',
      ),
    ).toHaveLength(2);
  });
});

describe('review polish', () => {
  it('does not describe a field the role cannot write in a completed partial', async () => {
    const client = createMockTwentyCrmClient();
    await client.createPerson({
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
          canCreate: true,
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
    const response = await fetch(`${gateway.url}/v1/ai/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        intent:
          'update person named Ada Lovelace set email to ada@analytical.example',
      }),
    });
    const text = await response.text();
    const partial = text.slice(0, text.indexOf('event: error'));

    expect(partial).toContain('Planning update_record');
    expect(partial).not.toContain('ada@analytical.example');
    expect(partial).not.toContain('email');
    expect(text).toContain('"reason":"forbidden"');
    expect(text).not.toContain('proposal_');
    expect(client.created).toHaveLength(1);
  });

  it('holds the undo lock in the shared state file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-lock-'));
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
    const busy = second.undos.begin(ticket?.id ?? '', 'member_ada', 'ws_demo');
    first.undos.release('member_ada');
    const after = second.undos.begin(ticket?.id ?? '', 'member_ada', 'ws_demo');
    second.undos.release('member_ada');
    const held = first.undos.begin(ticket?.id ?? '', 'member_ada', 'ws_demo');
    const database = new DatabaseSync(file);
    database
      .prepare('UPDATE undo_lock SET locked_at = 0 WHERE member_id = ?')
      .run('member_ada');
    const stolen = second.undos.begin(
      ticket?.id ?? '',
      'member_ada',
      'ws_demo',
    );
    database.close();

    expect(begun.ok).toBe(true);
    expect(busy).toEqual({ ok: false, reason: 'busy' });
    expect(after.ok).toBe(true);
    expect(held.ok).toBe(true);
    expect(stolen.ok).toBe(true);
  });
});

async function openGateway(
  client: TwentyCrmClient,
  llm?: LlmProvider,
): Promise<RunningGateway> {
  const gateway = await startGateway({
    port: 0,
    client,
    ...(llm ? { llm } : {}),
  });
  closers.push(() => gateway.close());
  return gateway;
}

async function postJson(
  gateway: RunningGateway,
  pathName: string,
  body: unknown,
  member = 'ada@analytical.example',
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${gateway.url}${pathName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-rex-member': member,
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

function confirmedId(payload: unknown): string {
  if (isRecord(payload) && typeof payload.confirmedPlanId === 'string') {
    return payload.confirmedPlanId;
  }

  throw new Error('Missing confirmed plan id');
}

function skillId(payload: unknown): string {
  if (
    isRecord(payload) &&
    isRecord(payload.skill) &&
    typeof payload.skill.id === 'string'
  ) {
    return payload.skill.id;
  }

  throw new Error('Missing skill id');
}

function toolArgs(payload: unknown, name: string): Record<string, unknown> {
  if (
    !isRecord(payload) ||
    !isRecord(payload.proposal) ||
    !Array.isArray(payload.proposal.tools)
  ) {
    return {};
  }

  const tool = payload.proposal.tools.find(
    (item) => isRecord(item) && item.name === name,
  );

  return isRecord(tool) && isRecord(tool.args) ? tool.args : {};
}
