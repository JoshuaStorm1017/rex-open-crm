import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { compensate } from './act/compensate';
import { isRecord } from './is-record';
import type { LlmProvider } from './llm/llm-provider';
import { startGateway, type RunningGateway } from './server';
import { openGatewayState } from './state/sqlite-state';
import { createMockTwentyCrmClient } from './twenty/mock-twenty-crm-client';
import type { TwentyCrmClient } from './twenty/twenty-crm-client';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    await close?.();
  }
});

describe('column cells on create previews', () => {
  it('puts name, email, and domain on the create, including an opportunity', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@analytical.example',
          },
        },
        {
          name: 'create_company',
          args: { name: 'Analytical Engines', domain: 'analytical.example' },
        },
        {
          name: 'create_opportunity',
          args: {
            name: 'Difference Engine',
            amount: 50000,
            stage: 'MEETING',
          },
        },
      ],
    });

    expect(proposalCreates(planned.payload)).toEqual([
      {
        objectName: 'person',
        label: 'Ada Lovelace',
        summary: 'ada@analytical.example',
        cells: [
          { field: 'name', value: 'Ada Lovelace' },
          { field: 'email', value: 'ada@analytical.example' },
        ],
      },
      {
        objectName: 'company',
        label: 'Analytical Engines',
        summary: 'analytical.example',
        cells: [
          { field: 'name', value: 'Analytical Engines' },
          { field: 'domain', value: 'analytical.example' },
        ],
      },
      {
        objectName: 'opportunity',
        label: 'Difference Engine',
        summary: '50000 · MEETING',
        cells: [
          { field: 'name', value: 'Difference Engine' },
          { field: 'amount', value: '50000' },
          { field: 'stage', value: 'MEETING' },
        ],
      },
    ]);
    expect(JSON.stringify(planned.payload)).not.toContain('"id":"person_');
    expect(client.created).toHaveLength(0);
  });
});

describe('partial timeline', () => {
  it('keeps the searches that returned and offers a retry for the one that failed', async () => {
    const client = createMockTwentyCrmClient();
    const deal = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Acme deal',
      stage: 'NEW',
    });
    await client.createNote({
      workspaceId: 'ws_demo',
      title: 'Buyer call',
      body: 'Talked about the pilot',
      targetObject: 'opportunity',
      targetId: deal.id,
    });
    client.created.push({
      id: 'task_deal',
      objectName: 'task',
      workspaceId: 'ws_demo',
      properties: {
        title: 'Send proposal',
        body: 'Draft',
        targetId: deal.id,
      },
      etag: 'v1',
      label: 'Send proposal',
    });
    const searchTasks = client.searchTasks.bind(client);
    client.searchTasks = async () => {
      throw new Error('tasks unavailable');
    };
    const gateway = await openGateway(client);
    const before = client.created.length;
    const response = await fetch(`${gateway.url}/v1/ai/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-rex-member': 'ada@analytical.example',
      },
      body: JSON.stringify({
        workspaceId: 'ws_demo',
        intent: 'what happened with this deal',
        context: { objectName: 'opportunity', recordId: deal.id },
      }),
    });
    const text = await response.text();
    const proposal = text
      .split('\n\n')
      .find((part) => part.startsWith('event: proposal'));

    expect(text).toContain('Buyer call');
    expect(text).toContain('event: read');
    expect(text).not.toContain('event: error');
    expect(proposal).toContain('failedReads');
    expect(proposal).toContain('search_tasks');
    expect(proposal).toContain('recordRef');
    expect(proposal).not.toContain('proposal_');
    expect(client.created).toHaveLength(before);

    client.searchTasks = searchTasks;
    const retried = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      context: { objectName: 'opportunity', recordId: deal.id },
      tools: [
        {
          name: 'search_tasks',
          args: { query: 'record', recordRef: 'open', limit: 8 },
        },
      ],
    });

    expect(retried.payload).toMatchObject({
      answer: {
        records: [expect.objectContaining({ label: 'Send proposal' })],
      },
    });
    expect(retried.payload).not.toHaveProperty('proposal');
    expect(client.created).toHaveLength(before);
  });
});

describe('richer skill parameters', () => {
  it('fills stage, company, owner, and close date before confirm', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const deal = await client.createOpportunity({
      workspaceId: 'ws_demo',
      name: 'Difference Engine',
      stage: 'NEW',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: {
            object: 'opportunity',
            id: deal.id,
            field: 'stage',
            value: 'MEETING',
          },
        },
        {
          name: 'update_record',
          args: {
            object: 'opportunity',
            id: deal.id,
            field: 'closeDate',
            value: '2026-12-01',
          },
        },
        {
          name: 'update_record',
          args: {
            object: 'opportunity',
            id: deal.id,
            field: 'owner',
            value: 'me',
          },
        },
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
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
    const saved = await postJson(gateway, '/v1/ai/skills', {
      workspaceId: 'ws_demo',
      skillName: 'Staff a deal',
      confirmedPlanId: confirmedId(acted.payload),
      blanks: ['stage', 'closeDate', 'owner', 'company'],
    });
    const skill = skillId(saved.payload);
    const open = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
    });
    const rejected = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
      parameterValues: {
        stage: 'WON',
        closeDate: '2026-11-05',
        owner: 'me',
        company: company.id,
      },
    });
    const filled = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
      parameterValues: {
        stage: 'proposal',
        closeDate: '2026-11-05',
        owner: 'me',
        company: company.id,
        email: 'ada@elsewhere.example',
      },
    });
    const extraField = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
      parameterValues: {
        stage: 'PROPOSAL',
        closeDate: '2026-11-05',
        owner: 'me',
        company: company.id,
      },
    });

    expect(open.payload).toMatchObject({
      parameters: [
        {
          name: 'stage',
          control: 'stage',
          options: expect.arrayContaining(['PROPOSAL']),
        },
        { name: 'closeDate', control: 'date' },
        { name: 'owner', control: 'owner' },
        { name: 'company', control: 'company' },
      ],
    });
    expect(open.payload).not.toHaveProperty('proposal');
    expect(rejected.payload).toMatchObject({
      refused: true,
      reason: 'invalid_request',
    });
    expect(filled.payload).toMatchObject({ refused: true });
    expect(extraField.payload).toMatchObject({
      proposal: {
        tools: [
          expect.objectContaining({
            args: expect.objectContaining({
              field: 'stage',
              value: 'PROPOSAL',
            }),
          }),
          expect.objectContaining({
            args: expect.objectContaining({
              field: 'closeDate',
              value: '2026-11-05',
            }),
          }),
          expect.objectContaining({
            args: expect.objectContaining({ field: 'owner', value: 'me' }),
          }),
          {
            name: 'create_person',
            args: {
              firstName: 'Ada',
              lastName: 'Lovelace',
              companyId: company.id,
            },
          },
        ],
      },
    });
    expect(JSON.stringify(extraField.payload)).not.toContain(
      'elsewhere.example',
    );
    expect(
      client.created.filter((record) => record.objectName === 'person'),
    ).toHaveLength(1);

    const confirmed = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(extraField.payload),
    });

    expect(confirmed.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === deal.id)?.properties.stage,
    ).toBe('PROPOSAL');
    expect(
      client.created.filter((record) => record.objectName === 'person'),
    ).toHaveLength(2);
  });
});

describe('link the company already on file', () => {
  it('offers the existing company and leaves the proposal unchanged until it is picked', async () => {
    const client = createMockTwentyCrmClient();
    const existing = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Northwind', domain: 'analytical.example' },
        },
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@analytical.example',
            companyId: '$0',
          },
        },
      ],
    });
    const originalId = proposalId(planned.payload);
    const linked = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      proposalId: originalId,
      linkCompanyId: existing.id,
    });
    const reloaded = await postJson(gateway, '/v1/ai/repropose', {
      workspaceId: 'ws_demo',
      proposalId: originalId,
    });

    expect(planned.payload).toMatchObject({
      proposal: {
        warnings: [
          {
            code: 'duplicate_domain',
            link: { companyId: existing.id, label: 'Analytical Engines' },
          },
        ],
        tools: [
          {
            name: 'create_company',
            args: { name: 'Northwind', domain: 'analytical.example' },
          },
          {
            name: 'create_person',
            args: expect.objectContaining({ companyId: '$0' }),
          },
        ],
      },
    });
    expect(proposalId(linked.payload)).not.toBe(originalId);
    expect(proposalTools(linked.payload)).toEqual([
      {
        name: 'create_person',
        args: expect.objectContaining({
          firstName: 'Ada',
          companyId: existing.id,
        }),
      },
    ]);
    expect(proposalTools(reloaded.payload).map((tool) => tool.name)).toEqual([
      'create_company',
      'create_person',
    ]);
    expect(
      client.created.filter((record) => record.objectName === 'company'),
    ).toHaveLength(1);

    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(linked.payload),
    });

    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.filter((record) => record.objectName === 'company'),
    ).toHaveLength(1);
    expect(
      client.created.find((record) => record.objectName === 'person')
        ?.properties.companyId,
    ).toBe(existing.id);
    expect(JSON.stringify(linked.payload)).toContain(
      'Linked to the company already on file.',
    );
  });

  it('does not attach a person or opportunity that was not tied to the new company', async () => {
    const client = createMockTwentyCrmClient();
    const existing = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Northwind', domain: 'analytical.example' },
        },
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            companyId: '$0',
          },
        },
        {
          name: 'create_person',
          args: { firstName: 'Grace', lastName: 'Hopper' },
        },
        {
          name: 'create_opportunity',
          args: { name: 'Pilot', companyId: '$0' },
        },
        {
          name: 'create_opportunity',
          args: { name: 'Unlinked deal' },
        },
      ],
    });
    const linked = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      proposalId: proposalId(planned.payload),
      linkCompanyId: existing.id,
    });
    const tools = proposalTools(linked.payload);
    const grace = tools.find((tool) => tool.args.firstName === 'Grace');
    const unlinkedDeal = tools.find(
      (tool) => tool.args.name === 'Unlinked deal',
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      'create_person',
      'create_person',
      'create_opportunity',
      'create_opportunity',
    ]);
    expect(
      tools.find((tool) => tool.args.firstName === 'Ada')?.args.companyId,
    ).toBe(existing.id);
    expect(grace?.args.companyId).toBeUndefined();
    expect(
      tools.find((tool) => tool.args.name === 'Pilot')?.args.companyId,
    ).toBe(existing.id);
    expect(unlinkedDeal?.args.companyId).toBeUndefined();
    expect(JSON.stringify(linked.payload)).toContain(
      'Create person Grace Hopper.',
    );
    expect(JSON.stringify(linked.payload)).not.toContain(
      'Create person Grace Hopper. Linked to the company already on file.',
    );
  });

  it('does not offer a link when nobody points at the new company', async () => {
    const client = createMockTwentyCrmClient();
    await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Northwind', domain: 'analytical.example' },
        },
        {
          name: 'create_person',
          args: { firstName: 'Grace', lastName: 'Hopper' },
        },
      ],
    });
    const warning = proposalWarnings(planned.payload)[0];

    expect(warning).toMatchObject({ code: 'duplicate_domain' });
    expect(warning).not.toHaveProperty('link');
  });

  it('refuses the link when the person company field is locked', async () => {
    const client = createMockTwentyCrmClient();
    const existing = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Northwind', domain: 'analytical.example' },
        },
        {
          name: 'create_person',
          args: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            companyId: '$0',
          },
        },
      ],
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
            { name: 'companyId', canUpdate: false },
          ],
        },
        {
          objectName: 'company',
          canRead: true,
          canUpdate: true,
          canCreate: true,
          canSoftDelete: false,
          fieldPermissions: [{ name: 'name', canUpdate: true }],
        },
      ],
    });

    const linked = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      proposalId: proposalId(planned.payload),
      linkCompanyId: existing.id,
    });

    client.loadCapabilities = undefined;
    const reloaded = await postJson(gateway, '/v1/ai/repropose', {
      workspaceId: 'ws_demo',
      proposalId: proposalId(planned.payload),
    });

    expect(linked.payload).toMatchObject({
      refused: true,
      reason: 'forbidden',
    });
    expect(linked.payload).not.toHaveProperty('proposal');
    expect(proposalTools(reloaded.payload).map((tool) => tool.name)).toEqual([
      'create_company',
      'create_person',
    ]);
    expect(
      client.created.filter((record) => record.objectName === 'person'),
    ).toHaveLength(0);
  });
});

describe('stolen undo', () => {
  it('drops the effect already reversed so the winner clears the ticket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-undo-win-'));
    const file = path.join(dir, 'state.sqlite');
    const state = openGatewayState(file);
    closers.push(async () => state.close());
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      jobTitle: 'Analyst',
    });
    const gateway = await startGateway({
      port: 0,
      client,
      undos: state.undos,
      proposals: state.proposals,
    });
    closers.push(() => gateway.close());
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
        {
          name: 'update_record',
          args: {
            object: 'person',
            id: person.id,
            field: 'jobTitle',
            value: 'Director',
          },
        },
      ],
    });
    await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const personEtag = client.created.find(
      (record) => record.id === person.id,
    )?.etag;
    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'person',
      id: person.id,
      field: 'jobTitle',
      value: 'Analyst',
      ifMatch: String(personEtag),
    });
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: state.undos.list('member_ada@analytical.example', 'ws_demo')[0]
        ?.id,
    });

    expect(undone.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Lisbon');
    expect(
      client.created.find((record) => record.id === person.id)?.properties
        .jobTitle,
    ).toBe('Analyst');
    expect(
      state.undos.list('member_ada@analytical.example', 'ws_demo'),
    ).toEqual([]);
  });

  it('still keeps a real conflict when the value is not already back', async () => {
    const client = createMockTwentyCrmClient();
    const person = await client.createPerson({
      workspaceId: 'ws_demo',
      firstName: 'Ada',
      lastName: 'Lovelace',
      jobTitle: 'Analyst',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: {
            object: 'person',
            id: person.id,
            field: 'jobTitle',
            value: 'Director',
          },
        },
      ],
    });
    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });
    const etag = client.created.find((record) => record.id === person.id)?.etag;
    await client.updateRecord({
      workspaceId: 'ws_demo',
      objectName: 'person',
      id: person.id,
      field: 'jobTitle',
      value: 'Chief',
      ifMatch: String(etag),
    });
    const undone = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId:
        isRecord(acted.payload) &&
        isRecord(acted.payload.undo) &&
        typeof acted.payload.undo.id === 'string'
          ? acted.payload.undo.id
          : '',
    });
    const ticket = [
      {
        kind: 'updated' as const,
        objectName: 'person' as const,
        id: person.id,
        field: 'jobTitle',
        previous: 'Analyst',
        written: 'Director',
        etag: 'stale',
      },
    ];
    const failures = await compensate(client, 'ws_demo', ticket);

    expect(undone.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
    });
    expect(
      client.created.find((record) => record.id === person.id)?.properties
        .jobTitle,
    ).toBe('Chief');
    expect(failures.some((failure) => failure.reason === 'conflict')).toBe(
      true,
    );
  });
});

describe('card photo review', () => {
  it('returns extracted lines for edit and creates every card only after confirm', async () => {
    const client = createMockTwentyCrmClient();
    const llm: LlmProvider = {
      async plan() {
        throw new Error('The planner must not run for a card photo.');
      },
      async readCard() {
        return [
          'Name: Ada Lovelace',
          'Company: Analytical Engines',
          'Email: ada@analytical.example',
          '---',
          'Name: Grace Hopper',
          'Company: Naval Engines',
          'Email: grace@naval.example',
        ].join('\n');
      },
    };
    const gateway = await openGateway(client, llm);
    const reviewed = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      confirmed: true,
      capture: {
        source: 'card',
        image: { mediaType: 'image/png', data: 'aaaa' },
      },
    });
    const edited = [
      'Name: Ada Lovelace',
      'Company: Analytical Engines',
      'Email: ada@analytical.example',
      '---',
      'Name: Grace Hopper',
      'Company: Naval Engines',
      'Email: grace@hopper.example',
    ].join('\n');
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: { source: 'card', text: edited },
    });

    expect(reviewed.payload).toMatchObject({
      captureReview: { cardCount: 2 },
    });
    expect(reviewed.payload).not.toHaveProperty('proposal');
    expect(client.created).toHaveLength(0);
    expect(proposalTools(planned.payload).map((tool) => tool.name)).toEqual([
      'create_company',
      'create_person',
      'create_company',
      'create_person',
    ]);
    expect(JSON.stringify(planned.payload)).toContain('grace@hopper.example');
    expect(JSON.stringify(planned.payload)).not.toContain(
      'grace@naval.example',
    );

    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created
        .filter((record) => record.objectName === 'person')
        .map((record) => record.properties.email),
    ).toEqual(['ada@analytical.example', 'grace@hopper.example']);
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

function confirmedId(payload: unknown): string {
  if (isRecord(payload) && typeof payload.confirmedPlanId === 'string') {
    return payload.confirmedPlanId;
  }

  throw new Error('Missing confirmed plan');
}

function skillId(payload: unknown): string {
  if (
    isRecord(payload) &&
    isRecord(payload.skill) &&
    typeof payload.skill.id === 'string'
  ) {
    return payload.skill.id;
  }

  throw new Error('Missing skill');
}

function proposalCreates(payload: unknown): unknown {
  if (
    isRecord(payload) &&
    isRecord(payload.proposal) &&
    Array.isArray(payload.proposal.creates)
  ) {
    return payload.proposal.creates;
  }

  return [];
}

function proposalWarnings(payload: unknown): Array<Record<string, unknown>> {
  if (
    !isRecord(payload) ||
    !isRecord(payload.proposal) ||
    !Array.isArray(payload.proposal.warnings)
  ) {
    return [];
  }

  return payload.proposal.warnings.flatMap((warning) =>
    isRecord(warning) ? [warning] : [],
  );
}

function proposalTools(
  payload: unknown,
): Array<{ name?: string; args: Record<string, unknown> }> {
  if (
    !isRecord(payload) ||
    !isRecord(payload.proposal) ||
    !Array.isArray(payload.proposal.tools)
  ) {
    return [];
  }

  return payload.proposal.tools.flatMap((tool) =>
    isRecord(tool) && isRecord(tool.args)
      ? [
          {
            name: typeof tool.name === 'string' ? tool.name : undefined,
            args: tool.args,
          },
        ]
      : [],
  );
}
