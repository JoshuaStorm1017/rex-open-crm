import { describe, expect, it } from 'vitest';

import {
  CURSOR_API_ORIGIN,
  CursorCloudAdapter,
} from './adapters/cursor-adapter';

const KEY = 'sk-test-secret-value';
const REPOSITORY = 'https://github.com/example/rex-demo';
const SHA = 'a'.repeat(40);

describe('cursor cloud adapter', () => {
  it('does not call the network when disabled or pointed at a non-example repository', async () => {
    const fetchImpl = fakeFetch();
    const disabled = new CursorCloudAdapter({
      enabled: false,
      apiKey: KEY,
      fetchImpl: fetchImpl.fetch,
    });
    expect((await disabled.launch(launchInput())).outcome).toBe('refused');
    const missingKey = new CursorCloudAdapter({
      enabled: true,
      fetchImpl: fetchImpl.fetch,
    });
    expect(reasonOf(await missingKey.launch(launchInput()))).toBe(
      'cursor_adapter_disabled',
    );
    const realRepository = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: fetchImpl.fetch,
    });
    expect(
      reasonOf(
        await realRepository.launch({
          ...launchInput(),
          repository: 'https://github.com/twentyhq/twenty',
        }),
      ),
    ).toBe('example_repository_required');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('posts a documented v1 create and does not retry a failed launch', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error(`socket hang up Authorization: Bearer ${KEY}`);
    });
    const adapter = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: fetchImpl.fetch,
    });
    const result = await adapter.launch({
      ...launchInput(),
      agentId: 'bc-11111111-1111-1111-1111-111111111111',
    });
    expect(result.outcome).toBe('unknown');
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]?.url).toBe(`${CURSOR_API_ORIGIN}/v1/agents`);
    expect(fetchImpl.calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(fetchImpl.calls[0]?.init.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      autoCreatePR: false,
      workOnCurrentBranch: false,
      agentId: 'bc-11111111-1111-1111-1111-111111111111',
      repos: [{ url: REPOSITORY, startingRef: SHA }],
    });
    expect(body).not.toHaveProperty('webhook');
    expect(body).not.toHaveProperty('webhookUrl');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('treats 409 as an existing agent and does not post a second create', async () => {
    const fetchImpl = fakeFetch(async () =>
      response(409, { code: 'agent_id_conflict' }),
    );
    const adapter = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: fetchImpl.fetch,
    });
    const result = await adapter.launch({
      ...launchInput(),
      agentId: 'bc-22222222-2222-2222-2222-222222222222',
    });
    expect(result).toEqual({
      outcome: 'conflict_exists',
      externalId: 'bc-22222222-2222-2222-2222-222222222222',
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('maps server errors to unknown and a successful body to the agent id', async () => {
    const failure = fakeFetch(async () => response(503, { error: KEY }));
    const failing = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: failure.fetch,
    });
    expect((await failing.launch(launchInput())).outcome).toBe('unknown');
    expect(JSON.stringify(await failing.launch(launchInput()))).not.toContain(
      KEY,
    );

    const success = fakeFetch(async () =>
      response(200, {
        agent: { id: 'bc-33333333-3333-4333-8333-333333333333' },
        run: { id: 'run-33333333-3333-4333-8333-333333333333' },
      }),
    );
    const working = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: success.fetch,
    });
    expect(await working.launch(launchInput())).toEqual({
      outcome: 'accepted',
      externalId: 'bc-33333333-3333-4333-8333-333333333333',
      runId: 'run-33333333-3333-4333-8333-333333333333',
    });
  });

  it('sends one non-idempotent follow-up and reconciles from the run list', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      if (url.endsWith('/runs') && !url.includes('?')) {
        throw new Error('timed out');
      }

      return response(200, {
        items: [
          {
            id: 'run-old',
            createdAt: '2026-11-07T00:00:00.000Z',
          },
          {
            id: 'run-new',
            createdAt: '2026-11-07T00:05:00.000Z',
          },
        ],
      });
    });
    const adapter = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: fetchImpl.fetch,
    });
    const sent = await adapter.followUp({
      agentId: 'bc-33333333-3333-4333-8333-333333333333',
      prompt: 'Repair the demo label.',
    });
    expect(sent.outcome).toBe('unknown');
    expect(fetchImpl.calls).toHaveLength(1);
    const followUp = fetchImpl.calls[0];
    expect(followUp?.url).toBe(
      `${CURSOR_API_ORIGIN}/v1/agents/bc-33333333-3333-4333-8333-333333333333/runs`,
    );
    expect(JSON.parse(followUp?.init.body ?? '{}')).toEqual({
      prompt: { text: 'Repair the demo label.' },
    });
    const reconciled = await adapter.reconcileFollowUp({
      agentId: 'bc-33333333-3333-4333-8333-333333333333',
      intendedAt: '2026-11-07T00:04:00.000Z',
      knownRunIds: ['run-old'],
    });
    expect(reconciled).toEqual({ outcome: 'present', externalId: 'run-new' });
    const ambiguous = await adapter.reconcileFollowUp({
      agentId: 'bc-33333333-3333-4333-8333-333333333333',
      intendedAt: '2026-11-07T00:00:00.000Z',
      knownRunIds: [],
    });
    expect(ambiguous.outcome).toBe('uncertain');
    const absent = await adapter.reconcileFollowUp({
      agentId: 'bc-33333333-3333-4333-8333-333333333333',
      intendedAt: '2026-11-07T00:06:00.000Z',
      knownRunIds: [],
    });
    expect(absent.outcome).toBe('absent');
  });

  it('reads an agent with GET and treats 404 as absent', async () => {
    const missing = fakeFetch(async () => response(404, {}));
    const adapter = new CursorCloudAdapter({
      enabled: true,
      apiKey: KEY,
      fetchImpl: missing.fetch,
    });
    expect(
      await adapter.reconcileLaunch('bc-44444444-4444-4444-8444-444444444444'),
    ).toEqual({ outcome: 'absent' });
    expect(missing.calls[0]?.init.method).toBe('GET');
    expect(missing.calls[0]?.url).toBe(
      `${CURSOR_API_ORIGIN}/v1/agents/bc-44444444-4444-4444-8444-444444444444`,
    );
  });
});

function reasonOf(result: {
  outcome: string;
  reason?: string;
}): string | undefined {
  return result.reason;
}

function launchInput() {
  return {
    prompt: 'Add the fictional demo label.',
    repository: REPOSITORY,
    startingRef: SHA,
  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeFetch(
  handler: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) =>
    | Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
    | never = async () => response(200, {}),
) {
  const calls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body?: string };
  }> = [];

  return {
    calls,
    fetch: async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}
