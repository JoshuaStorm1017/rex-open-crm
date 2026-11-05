import { describe, expect, it } from 'vitest';

import { executeAct } from './execute-act';
import { proposeAct } from './propose-act';
import { createMockLlmProvider } from '../llm/mock-llm-provider';
import { createOpenAiLlmProvider } from '../llm/openai-llm-provider';
import { readLlmConfigFromEnv } from '../llm/read-llm-config';
import { createMockTwentyCrmClient } from '../twenty/mock-twenty-crm-client';

const llm = createMockLlmProvider();

describe('proposeAct', () => {
  it('plans a company, a person, and a deal without writing', async () => {
    const client = createMockTwentyCrmClient();
    const planned = await proposeAct(
      {
        workspaceId: 'ws_demo',
        intent: 'add Acme Corp as a company and a $50k deal for Jane Doe',
      },
      client,
      llm,
    );

    expect(planned).toMatchObject({
      ok: true,
      proposal: {
        summary: expect.stringContaining('Create company'),
        tools: [
          { name: 'create_company', args: { name: 'Acme Corp' } },
          {
            name: 'create_person',
            args: { firstName: 'Jane', lastName: 'Doe' },
          },
          {
            name: 'create_opportunity',
            args: { amount: 50000, companyId: '$0', pointOfContactId: '$1' },
          },
        ],
      },
    });
    expect(client.created).toHaveLength(0);

    if (!planned.ok || !planned.proposal) {
      return;
    }

    const executed = await executeAct(
      {
        workspaceId: 'ws_demo',
        confirmed: true,
        tools: planned.proposal.tools,
      },
      client,
    );

    expect(executed.ok).toBe(true);
    expect(client.created.map((record) => record.objectName)).toEqual([
      'company',
      'person',
      'opportunity',
    ]);
    expect(client.created[2]?.properties).toMatchObject({
      amount: 50000,
      currencyCode: 'USD',
      companyId: client.created[0]?.id,
      pointOfContactId: client.created[1]?.id,
    });
  });

  it('refuses an unsafe intent before any write', async () => {
    const client = createMockTwentyCrmClient();
    const planned = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'delete all people' },
      client,
      llm,
    );

    expect(planned).toMatchObject({
      ok: false,
      refused: true,
      reason: 'unsafe_intent',
    });
    expect(client.created).toHaveLength(0);
  });

  it('refuses an update that does not name one record', async () => {
    const client = createMockTwentyCrmClient();
    const planned = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'update the deal' },
      client,
      llm,
    );

    expect(planned).toMatchObject({
      ok: false,
      refused: true,
      reason: 'ambiguous_intent',
    });
    expect(client.created).toHaveLength(0);
  });

  it('fills If-Match from the current record and refuses a stale one', async () => {
    const client = createMockTwentyCrmClient();
    const company = await client.createCompany({
      workspaceId: 'ws_demo',
      name: 'Analytical Engines',
      domain: 'analytical.example',
    });
    const planned = await proposeAct(
      {
        workspaceId: 'ws_demo',
        intent:
          'update company named Analytical Engines set domain to engines.example',
      },
      client,
      llm,
    );

    expect(planned).toMatchObject({
      ok: true,
      proposal: {
        tools: [
          {
            name: 'update_record',
            args: {
              object: 'company',
              id: company.id,
              field: 'domain',
              value: 'engines.example',
              ifMatch: 'v1',
            },
          },
        ],
      },
    });
    expect(client.created[0]?.properties.domain).toBe('analytical.example');

    const stale = await proposeAct(
      {
        workspaceId: 'ws_demo',
        tools: [
          {
            name: 'update_record',
            args: {
              object: 'company',
              id: company.id,
              field: 'domain',
              value: 'engines.example',
              ifMatch: 'v0',
            },
          },
        ],
      },
      client,
      llm,
    );

    expect(stale).toMatchObject({
      ok: false,
      refused: true,
      reason: 'precondition_failed',
    });
    expect(client.created[0]?.properties.domain).toBe('analytical.example');
  });

  it('refuses a model tool that is not allowlisted and does not write', async () => {
    const client = createMockTwentyCrmClient();
    const openai = createOpenAiLlmProvider(
      {
        provider: 'openai',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'test-llm-key',
        model: 'mock-model',
      },
      async (url, init) => {
        expect(String(url)).toBe('https://llm.example/v1/chat/completions');
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer test-llm-key',
        );
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'This only searches. Nothing will be written.',
                    tools: [{ name: 'delete_workspace', args: {} }],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );

    const planned = await proposeAct(
      { workspaceId: 'ws_demo', intent: 'delete the workspace' },
      client,
      openai,
    );

    expect(planned).toMatchObject({
      ok: false,
      refused: true,
      reason: 'unmapped_intent',
    });
    expect(JSON.stringify(planned)).toContain('free-form JSON');
    expect(client.created).toHaveLength(0);
  });
});

describe('readLlmConfigFromEnv', () => {
  it('defaults to the mock provider', () => {
    expect(readLlmConfigFromEnv({})).toEqual({ provider: 'mock' });
  });

  it('rejects an openai provider without a key, and a base URL that embeds credentials', () => {
    expect(() => readLlmConfigFromEnv({ REX_AI_PROVIDER: 'openai' })).toThrow(
      /REX_AI_API_KEY/,
    );
    expect(() =>
      readLlmConfigFromEnv({
        REX_AI_PROVIDER: 'openai',
        REX_AI_BASE_URL: 'https://user:secret@llm.example/v1',
        REX_AI_API_KEY: 'test-llm-key',
        REX_AI_MODEL: 'mock-model',
      }),
    ).toThrow(/credentials/);
    expect(() =>
      readLlmConfigFromEnv({
        REX_AI_PROVIDER: 'openai',
        REX_AI_BASE_URL: 'http://169.254.169.254/latest',
        REX_AI_API_KEY: 'test-llm-key',
        REX_AI_MODEL: 'mock-model',
      }),
    ).toThrow(/non-public|metadata|local/);
    expect(() =>
      readLlmConfigFromEnv({
        REX_AI_PROVIDER: 'openai',
        REX_AI_BASE_URL: 'http://127.0.0.1:9/v1',
        REX_AI_API_KEY: 'test-llm-key',
        REX_AI_MODEL: 'mock-model',
      }),
    ).toThrow(/non-public|local/);
    expect(() =>
      readLlmConfigFromEnv({
        REX_AI_PROVIDER: 'openai',
        REX_AI_BASE_URL: 'http://llm.example/v1',
        REX_AI_API_KEY: 'test-llm-key',
        REX_AI_MODEL: 'mock-model',
      }),
    ).toThrow(/https/);
    expect(
      readLlmConfigFromEnv({
        REX_AI_PROVIDER: 'openai',
        REX_AI_BASE_URL: 'https://api.openai.com/v1',
        REX_AI_API_KEY: 'test-llm-key',
        REX_AI_MODEL: 'mock-model',
      }).provider,
    ).toBe('openai');
  });
});
