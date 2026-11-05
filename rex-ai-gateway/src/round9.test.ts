import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { compensate } from './act/compensate';
import { isRecord } from './is-record';
import { createOpenAiLlmProvider } from './llm/openai-llm-provider';
import type { LlmProvider } from './llm/llm-provider';
import { CONFIRMED_PLAN_TTL_MS } from './http/skill-store';
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

describe('streamed timeline reads', () => {
  it('emits each note, task, and activity as that search returns', async () => {
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
    client.created.push({
      id: 'activity_deal',
      objectName: 'timelineActivity',
      workspaceId: 'ws_demo',
      properties: { name: 'Stage moved', linkedRecordId: deal.id },
      etag: 'v1',
      label: 'Stage moved',
    });
    const tasksGate = defer();
    const activitiesGate = defer();
    const searchTasks = client.searchTasks.bind(client);
    const searchActivities = client.searchActivities.bind(client);
    client.searchTasks = async (input) => {
      await tasksGate.promise;
      return searchTasks(input);
    };
    client.searchActivities = async (input) => {
      await activitiesGate.promise;
      return searchActivities(input);
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
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('Missing stream');
    }

    let text = '';
    text = await readUntil(reader, text, 'Buyer call');

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: read');
    expect(text).toContain('Buyer call');
    expect(text).not.toContain('Send proposal');
    expect(text).not.toContain('Stage moved');

    tasksGate.resolve();
    text = await readUntil(reader, text, 'Send proposal');
    expect(text).not.toContain('Stage moved');

    activitiesGate.resolve();
    text = await readUntil(reader, text, 'Stage moved');
    text = await readUntil(reader, text, 'event: proposal');

    expect(text).not.toContain('proposal_');
    expect(client.created).toHaveLength(before);
  });
});

describe('parameterized skills', () => {
  it('fills a blank city before confirm and does not keep the last literal', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      city: 'Lisbon',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'update_record',
          args: {
            object: 'company',
            id: company.id,
            field: 'city',
            value: 'Porto',
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
    const saved = await postJson(gateway, '/v1/ai/skills', {
      workspaceId: 'ws_demo',
      skillName: 'Move city',
      confirmedPlanId,
      blanks: ['city'],
    });
    const skill = skillId(saved.payload);
    const open = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
    });
    const filled = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
      parameterValues: { city: 'Faro' },
    });

    expect(saved.payload).toMatchObject({
      skill: { parameters: ['city'] },
    });
    expect(open.payload).toMatchObject({
      parameters: [{ name: 'city', label: 'City' }],
    });
    expect(open.payload).not.toHaveProperty('proposal');
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Porto');
    expect(filled.payload).toMatchObject({
      proposal: {
        tools: [{ name: 'update_record', args: { value: 'Faro' } }],
      },
    });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Porto');

    const confirmed = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(filled.payload),
    });

    expect(confirmed.payload).toMatchObject({ ok: true });
    expect(
      client.created.find((record) => record.id === company.id)?.properties
        .city,
    ).toBe('Faro');
  });

  it('fills amount and stage on a saved create before confirm', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_opportunity',
          args: { name: 'Acme deal', amount: 1000, stage: 'NEW' },
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
      skillName: 'New deal',
      confirmedPlanId: confirmedId(acted.payload),
      blanks: ['amount', 'stage'],
    });
    const skill = skillId(saved.payload);
    const before = client.created.length;
    const open = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
    });
    const filled = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      skillId: skill,
      parameterValues: { amount: 2500, stage: 'PROPOSAL' },
    });

    expect(open.payload).not.toHaveProperty('proposal');
    expect(client.created).toHaveLength(before);
    expect(filled.payload).toMatchObject({
      proposal: {
        tools: [
          {
            name: 'create_opportunity',
            args: { amount: 2500, stage: 'PROPOSAL' },
          },
        ],
      },
    });
    const tool = proposalTools(filled.payload)[0];
    expect(tool?.args.amount).not.toBe(1000);
    expect(tool?.args.stage).not.toBe('NEW');
  });
});

describe('card photo', () => {
  it('reads a card image through a vision provider into the create preview', async () => {
    const client = createMockTwentyCrmClient();
    const llm: LlmProvider = {
      async plan() {
        throw new Error('The planner must not run for a card photo.');
      },
      async readCard() {
        return 'Name: Ada Lovelace\nCompany: Analytical Engines\nEmail: ada@analytical.example';
      },
    };
    const gateway = await openGateway(client, llm);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: {
        source: 'card',
        image: { mediaType: 'image/png', data: 'aaaa' },
      },
    });

    expect(planned.payload).toMatchObject({
      proposal: {
        tools: [
          { name: 'create_company', args: { name: 'Analytical Engines' } },
          {
            name: 'create_person',
            args: {
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: 'ada@analytical.example',
            },
          },
        ],
      },
    });
    expect(client.created).toHaveLength(0);

    const acted = await postJson(gateway, '/v1/ai/act', {
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: proposalId(planned.payload),
    });

    expect(acted.payload).toMatchObject({ ok: true });
    expect(client.created.map((record) => record.objectName)).toEqual([
      'company',
      'person',
    ]);
  });

  it('keeps paste and vCard when no vision model is configured', async () => {
    const client = createMockTwentyCrmClient();
    const gateway = await openGateway(client);
    const photo = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: {
        source: 'card',
        image: { mediaType: 'image/jpeg', data: 'aaaa' },
      },
    });
    const pasted = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      capture: {
        source: 'card',
        text: 'BEGIN:VCARD\nN:Lovelace;Ada;;;\nFN:Ada Lovelace\nORG:Analytical Engines\nEMAIL:ada@analytical.example\nEND:VCARD',
      },
    });

    expect(photo.payload).toMatchObject({
      refused: true,
      message: 'No vision model is configured. Paste the card text or a vCard.',
    });
    expect(pasted.payload).toMatchObject({
      proposal: {
        tools: [
          { name: 'create_company' },
          { name: 'create_person', args: { firstName: 'Ada' } },
        ],
      },
    });
    expect(client.created).toHaveLength(0);
  });

  it('asks a vision-capable provider for labelled card text and not tool calls', async () => {
    let body = '';
    const provider = createOpenAiLlmProvider(
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-4o',
        vision: true,
      },
      (async (_url, init) => {
        body = String(init?.body);

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Name: Ada Lovelace\nCompany: Analytical Engines',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    const text = await provider.readCard?.({
      mediaType: 'image/png',
      data: 'aaaa',
    });
    const plain = createOpenAiLlmProvider({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    });

    expect(text).toContain('Name: Ada Lovelace');
    expect(body).toContain('data:image/png;base64,aaaa');
    expect(body).not.toContain('tool_choice');
    expect(plain.readCard).toBeUndefined();
  });
});

describe('same-domain company warning', () => {
  it('warns without rewriting the proposed domain', async () => {
    const client = createMockTwentyCrmClient();
    await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Acme',
      domain: 'acme.example',
    });
    const gateway = await openGateway(client);
    const planned = await postJson(gateway, '/v1/ai/plan', {
      workspaceId: 'ws_demo',
      tools: [
        {
          name: 'create_company',
          args: { name: 'Northwind', domain: 'acme.example' },
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
            name: 'create_company',
            args: { name: 'Northwind', domain: 'acme.example' },
          },
        ],
        warnings: [
          {
            code: 'duplicate_domain',
            message: expect.stringContaining('acme.example'),
          },
        ],
      },
    });
    expect(acted.payload).toMatchObject({ ok: true });
    expect(
      client.created.filter(
        (record) => record.properties.domain === 'acme.example',
      ),
    ).toHaveLength(2);
  });
});

describe('review polish', () => {
  it('rejects a second skill with the same name from the unique index', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-skill-'));
    const file = path.join(dir, 'state.sqlite');
    const state = openGatewayState(file);
    closers.push(async () => state.close());
    const tools = [
      {
        name: 'update_record',
        args: {
          object: 'company',
          id: 'company_1',
          field: 'city',
          value: 'Faro',
        },
      },
    ];
    const first = state.skills.saveSkill(
      'member_ada',
      'ws_demo',
      'Move city',
      tools,
    );
    const second = state.skills.saveSkill(
      'member_ada',
      'ws_demo',
      'move city',
      tools,
    );
    const database = new DatabaseSync(file);
    const index = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'skills_member_name'",
      )
      .get() as { name?: string } | undefined;
    database.close();

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'duplicate' });
    expect(index?.name).toBe('skills_member_name');
  });

  it('expires a confirmed plan by time as well as the cap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-plan-'));
    const file = path.join(dir, 'state.sqlite');
    const state = openGatewayState(file);
    closers.push(async () => state.close());
    const plan = state.skills.saveConfirmed(
      'member_ada@analytical.example',
      'ws_demo',
      [{ name: 'create_company', args: { name: 'Acme' } }],
      Date.now() - CONFIRMED_PLAN_TTL_MS - 1000,
    );
    const gateway = await startGateway({
      port: 0,
      client: createMockTwentyCrmClient(),
      skills: state.skills,
    });
    closers.push(() => gateway.close());
    const saved = await postJson(gateway, '/v1/ai/skills', {
      workspaceId: 'ws_demo',
      skillName: 'Old plan',
      confirmedPlanId: plan?.id,
    });

    expect(
      state.skills.readConfirmed(
        plan?.id ?? '',
        'member_ada@analytical.example',
      ),
    ).toBeUndefined();
    expect(saved.payload).toMatchObject({
      refused: true,
      reason: 'not_found',
    });
  });

  it('stops later reversals after a stolen lock and If-Match rejects the second write', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rex-undo-'));
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
    const memberId = 'member_ada@analytical.example';
    const ticket = state.undos.list(memberId, 'ws_demo')[0];
    const writtenEtag = client.created.find(
      (record) => record.id === person.id,
    )?.etag;

    if (!ticket) {
      throw new Error('Missing undo');
    }

    const winnerStore = openGatewayState(file);
    closers.push(async () => winnerStore.close());
    const original = client.updateRecord.bind(client);
    let updates = 0;
    let stolenOk = false;
    client.updateRecord = async (input) => {
      updates += 1;

      if (updates === 1) {
        const database = new DatabaseSync(file);
        database
          .prepare('UPDATE undo_lock SET locked_at = 0 WHERE member_id = ?')
          .run(memberId);
        database.close();
        stolenOk = winnerStore.undos.begin(ticket.id, memberId, 'ws_demo').ok;
      }

      return original(input);
    };
    const loser = await postJson(gateway, '/v1/ai/undo', {
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: ticket.id,
    });
    let secondReversalRejected = false;

    try {
      await original({
        workspaceId: 'ws_demo',
        objectName: 'person',
        id: person.id,
        field: 'jobTitle',
        value: 'Director',
        ifMatch: String(writtenEtag),
      });
    } catch (error) {
      secondReversalRejected = error instanceof CrmPreconditionError;
    }

    const loserWrites = updates;
    const cityAfterLoser = client.created.find(
      (record) => record.id === company.id,
    )?.properties.city;
    const failures = await compensate(client, 'ws_demo', ticket.effects, () =>
      winnerStore.undos.holdsLock(memberId),
    );

    expect(stolenOk).toBe(true);
    expect(loserWrites).toBe(1);
    expect(loser.payload).toMatchObject({
      refused: true,
      reason: 'precondition_failed',
    });
    expect(
      state.undos.list(memberId, 'ws_demo').map((item) => item.id),
    ).toContain(ticket.id);
    expect(cityAfterLoser).toBe('Faro');
    expect(
      client.created.find((record) => record.id === person.id)?.properties
        .jobTitle,
    ).toBe('Analyst');
    expect(failures.some((failure) => failure.reason === 'conflict')).toBe(
      true,
    );
    expect(secondReversalRejected).toBe(true);
    winnerStore.undos.release(memberId);
  });
});

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let next = text;

  while (!next.includes(needle)) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    next += decoder.decode(chunk.value, { stream: true });
  }

  return next;
}

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
