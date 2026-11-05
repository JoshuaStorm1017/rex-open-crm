import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { AiCommandBar } from '@/ai-command-bar/components/AiCommandBar';
import {
  readAiCommandBarConfig,
  type AiCommandBarConfig,
} from '@/ai-command-bar/utils/readAiCommandBarConfig';
import { isAiCommandBarShortcut } from '@/ai-command-bar/utils/isAiCommandBarShortcut';

i18n.load('en', {});
i18n.activate('en');

const config: AiCommandBarConfig = {
  gatewayUrl: 'http://127.0.0.1:8787',
  workspaceId: 'ws_demo',
};

const INTENT = 'add Acme Corp as a company and a $50k deal for Jane Doe';

const proposal = {
  ok: true,
  workspaceId: 'ws_demo',
  proposal: {
    id: 'proposal_11111111-1111-4111-8111-111111111111',
    summary: 'Create Acme Corp, Jane Doe, and a $50,000 opportunity.',
    tools: [
      { name: 'create_company', args: { name: 'Acme Corp' } },
      { name: 'create_person', args: { firstName: 'Jane', lastName: 'Doe' } },
      {
        name: 'create_opportunity',
        args: { name: 'Acme Corp deal', amount: 50000 },
      },
    ],
    lines: [
      { tool: 'create_company', summary: 'Create company "Acme Corp".' },
      { tool: 'create_person', summary: 'Create person Jane Doe.' },
      {
        tool: 'create_opportunity',
        summary: 'Create opportunity "Acme Corp deal" for $50,000.',
      },
    ],
  },
};

const created = {
  ok: true,
  workspaceId: 'ws_demo',
  results: [
    {
      tool: 'create_company',
      status: 'created',
      record: { id: 'company_1', objectName: 'company', label: 'Acme Corp' },
    },
    {
      tool: 'create_person',
      status: 'created',
      record: { id: 'person_1', objectName: 'person', label: 'Jane Doe' },
    },
    {
      tool: 'create_opportunity',
      status: 'created',
      record: {
        id: 'opportunity_1',
        objectName: 'opportunity',
        label: 'Acme Corp deal',
      },
    },
  ],
};

const jsonResponse = (body: unknown) =>
  Promise.resolve({
    ok: true,
    json: async () => body,
  } as Response);

const renderBar = (fetchImpl: typeof fetch, initialOpen = false) =>
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>
        <AiCommandBar
          config={config}
          fetchImpl={fetchImpl}
          initialOpen={initialOpen}
        />
      </MemoryRouter>
    </I18nProvider>,
  );

describe('isAiCommandBarShortcut', () => {
  const event = {
    code: 'KeyK',
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    repeat: false,
  };

  it('accepts ctrl+shift+k and cmd+shift+k, and not the command menu shortcut', () => {
    expect(isAiCommandBarShortcut(event)).toBe(true);
    expect(
      isAiCommandBarShortcut({ ...event, ctrlKey: false, metaKey: true }),
    ).toBe(true);
    expect(isAiCommandBarShortcut({ ...event, shiftKey: false })).toBe(false);
    expect(isAiCommandBarShortcut({ ...event, code: 'KeyJ' })).toBe(false);
  });
});

describe('AiCommandBar', () => {
  it('proposes a command, confirms it, and links to the created records', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/v1/ai/plan')) {
          return jsonResponse(proposal);
        }

        return jsonResponse(created);
      },
    );

    renderBar(fetchImpl, true);

    await user.type(screen.getByRole('textbox', { name: 'Command' }), INTENT);
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(
      await screen.findByText('Create company "Acme Corp".'),
    ).toBeInTheDocument();
    expect(screen.getByText('Create person Jane Doe.')).toBeInTheDocument();
    expect(
      screen.getByText('Create opportunity "Acme Corp deal" for $50,000.'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByRole('link', { name: 'Acme Corp' }),
    ).toHaveAttribute('href', '/object/company/company_1');
    expect(screen.getByRole('link', { name: 'Jane Doe' })).toHaveAttribute(
      'href',
      '/object/person/person_1',
    );
    expect(
      screen.getByRole('link', { name: 'Acme Corp deal' }),
    ).toHaveAttribute('href', '/object/opportunity/opportunity_1');

    const actCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith('/v1/ai/act'),
    );
    const actInit = actCall?.[1];
    const headers = actInit?.headers as Record<string, string>;

    expect(JSON.parse(String(actInit?.body))).toEqual({
      workspaceId: 'ws_demo',
      confirmed: true,
      proposalId: 'proposal_11111111-1111-4111-8111-111111111111',
    });
    expect(headers['idempotency-key']).toEqual(expect.any(String));
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-rex-actor']).toBeUndefined();
    expect(actInit?.credentials).toBe('include');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancels a preview without executing', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async (_input: RequestInfo | URL) =>
      jsonResponse(proposal),
    );

    renderBar(fetchImpl, true);

    await user.type(screen.getByRole('textbox', { name: 'Command' }), INTENT);
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    expect(
      await screen.findByRole('button', { name: 'Cancel' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.getByText('Cancelled. Nothing was changed.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/v1/ai/plan');
  });

  it('opens from the keyboard shortcut', async () => {
    const fetchImpl = jest.fn();

    renderBar(fetchImpl);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyK',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(
      screen.getByRole('dialog', { name: 'AI command' }),
    ).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('closes from escape without calling the gateway', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn();

    renderBar(fetchImpl, true);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks which record to update when several names match', async () => {
    const user = userEvent.setup();
    const choiceProposal = {
      ok: true,
      workspaceId: 'ws_demo',
      proposal: {
        id: 'proposal_22222222-2222-4222-8222-222222222222',
        summary: 'Several company records match. Choose one, then confirm.',
        tools: [],
        lines: [
          { tool: 'update_record', summary: 'Acme North' },
          { tool: 'update_record', summary: 'Acme South' },
        ],
        choice: {
          prompt: 'Several company records match. Choose one, then confirm.',
          candidates: [
            { id: 'company_north', label: 'Acme North', objectName: 'company' },
            { id: 'company_south', label: 'Acme South', objectName: 'company' },
          ],
        },
      },
    };
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/ai/plan')) {
        return jsonResponse(choiceProposal);
      }

      return jsonResponse({ ok: true, results: [] });
    });

    renderBar(fetchImpl, true);

    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company named Acme set domain to acme.example',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(
      await screen.findByRole('radio', { name: 'Acme North' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Acme South' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const actCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith('/v1/ai/act'),
    );

    expect(JSON.parse(String(actCall?.[1]?.body))).toMatchObject({
      confirmed: true,
      proposalId: 'proposal_22222222-2222-4222-8222-222222222222',
      choiceId: 'company_south',
    });
  });
});

describe('readAiCommandBarConfig', () => {
  it('does not copy a gateway token out of window._env_', () => {
    window._env_ = {
      REX_AI_GATEWAY_TOKEN: 'secret-token',
      REX_AI_GATEWAY_URL: 'http://localhost:8787',
      REX_AI_WORKSPACE_ID: 'ws_demo',
    };

    expect(readAiCommandBarConfig()).toEqual({
      gatewayUrl: 'http://localhost:8787',
      workspaceId: 'ws_demo',
    });
    expect(readAiCommandBarConfig()).not.toHaveProperty('bearerToken');
  });

  it('does not send credentialed commands to another host', () => {
    window._env_ = {
      REX_AI_GATEWAY_URL: 'https://collector.example/steal',
    };

    expect(readAiCommandBarConfig().gatewayUrl).not.toContain(
      'collector.example',
    );
  });
});
