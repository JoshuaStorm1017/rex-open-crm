import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, getDefaultStore, Provider } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { SidePanelPages } from 'twenty-shared/types';

import { sidePanelNavigationStackState } from '@/side-panel/states/sidePanelNavigationStackState';

import { readOpenRecordFromPath } from '@/ai-command-bar/utils/readOpenRecordFromPath';

import { AiCommandBar } from '@/ai-command-bar/components/AiCommandBar';
import { AiRecordFieldPreview } from '@/ai-command-bar/components/AiRecordFieldPreview';
import { AiRecordTableFieldPreview } from '@/ai-command-bar/components/AiRecordTableFieldPreview';
import { AiRecordTableGhostRows } from '@/ai-command-bar/components/AiRecordTableGhostRows';
import { aiCommandBarCreatePreviewState } from '@/ai-command-bar/states/aiCommandBarCreatePreviewState';
import { aiCommandBarFieldPreviewState } from '@/ai-command-bar/states/aiCommandBarFieldPreviewState';
import {
  readAiCommandBarConfig,
  type AiCommandBarConfig,
} from '@/ai-command-bar/utils/readAiCommandBarConfig';
import { isAiCommandBarShortcut } from '@/ai-command-bar/utils/isAiCommandBarShortcut';
import {
  FieldContext,
  type GenericFieldContextType,
} from '@/object-record/record-field/ui/contexts/FieldContext';

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

const renderBar = (
  fetchImpl: typeof fetch,
  initialOpen = false,
  initialPath = '/',
) =>
  render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialPath]}>
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
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith('/v1/ai/plan')) {
          return jsonResponse(choiceProposal);
        }

        return jsonResponse({ ok: true, results: [] });
      },
    );

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

describe('record page and undo', () => {
  it('sends the open record and can undo the confirmed act', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/v1/ai/plan')) {
          return jsonResponse(proposal);
        }

        if (url.endsWith('/v1/ai/undo')) {
          return jsonResponse({
            ok: true,
            summary: 'Reversed the last confirmed change.',
          });
        }

        return jsonResponse({
          ...created,
          undo: {
            id: 'undo_33333333-3333-4333-8333-333333333333',
            summary: 'Undo 3 created records.',
          },
        });
      },
    );

    renderBar(fetchImpl, true, '/object/opportunity/opportunity_1');

    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveAttribute(
      'placeholder',
      "Update this deal's stage to Proposal",
    );

    await user.type(screen.getByRole('textbox', { name: 'Command' }), INTENT);
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await screen.findByRole('button', { name: 'Confirm' });

    const planCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith('/v1/ai/plan'),
    );

    expect(JSON.parse(String(planCall?.[1]?.body))).toEqual({
      workspaceId: 'ws_demo',
      intent: INTENT,
      context: { objectName: 'opportunity', recordId: 'opportunity_1' },
    });

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText('Undone. The last change was reversed.'),
    ).toBeInTheDocument();

    const undoCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith('/v1/ai/undo'),
    );

    expect(JSON.parse(String(undoCall?.[1]?.body))).toEqual({
      workspaceId: 'ws_demo',
      confirmed: true,
      undoId: 'undo_33333333-3333-4333-8333-333333333333',
    });
  });

  it('offers creating a new record when several names match', async () => {
    const user = userEvent.setup();
    const choiceProposal = {
      ok: true,
      workspaceId: 'ws_demo',
      proposal: {
        id: 'proposal_22222222-2222-4222-8222-222222222222',
        summary:
          'Several people match “Jane Doe”. Choose one, or create a new one, then confirm.',
        tools: [],
        lines: [
          {
            tool: 'create_note',
            summary: 'Jane Doe · jane.north@example.test',
          },
          {
            tool: 'create_note',
            summary: 'Jane Doe · jane.south@example.test',
          },
          {
            tool: 'create_note',
            summary: 'Create new person “Jane Doe” and add the note',
          },
        ],
        choice: {
          prompt:
            'Several people match “Jane Doe”. Choose one, or create a new one, then confirm.',
          candidates: [
            {
              id: 'person_north',
              label: 'Jane Doe · jane.north@example.test',
              objectName: 'person',
              action: 'use',
            },
            {
              id: 'person_south',
              label: 'Jane Doe · jane.south@example.test',
              objectName: 'person',
              action: 'use',
            },
            {
              id: 'create_new',
              label: 'Create new person “Jane Doe” and add the note',
              objectName: 'person',
              action: 'create',
            },
          ],
        },
      },
    };
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        if (String(input).endsWith('/v1/ai/plan')) {
          return jsonResponse(choiceProposal);
        }

        return jsonResponse({ ok: true, results: [] });
      },
    );

    renderBar(fetchImpl, true);

    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'add a note to person named Jane Doe: Met at the fair',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(await screen.findByText('New record')).toBeInTheDocument();
    await user.click(
      screen.getByRole('radio', {
        name: 'Create new person “Jane Doe” and add the note',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const actCall = fetchImpl.mock.calls.find((call) =>
      String(call[0]).endsWith('/v1/ai/act'),
    );

    expect(JSON.parse(String(actCall?.[1]?.body))).toMatchObject({
      choiceId: 'create_new',
    });
  });
});

describe('picker detail and undo retry', () => {
  it('shows the record detail and keeps undo available when the reversal conflicts', async () => {
    const user = userEvent.setup();
    const choiceProposal = {
      ok: true,
      workspaceId: 'ws_demo',
      proposal: {
        id: 'proposal_22222222-2222-4222-8222-222222222222',
        summary:
          'Several companies match “Acme”. Choose one, or create a new one, then confirm.',
        tools: [],
        lines: [
          { tool: 'update_record', summary: 'Acme' },
          { tool: 'update_record', summary: 'Acme' },
          { tool: 'update_record', summary: 'Create new company “Acme”' },
        ],
        choice: {
          prompt:
            'Several companies match “Acme”. Choose one, or create a new one, then confirm.',
          candidates: [
            {
              id: 'company_north',
              label: 'Acme',
              detail: 'north.example · Lisbon',
              objectName: 'company',
              action: 'use',
            },
            {
              id: 'company_south',
              label: 'Acme',
              detail: 'south.example · Porto',
              objectName: 'company',
              action: 'use',
            },
            {
              id: 'create_new',
              label: 'Create new company “Acme”',
              objectName: 'company',
              action: 'create',
            },
          ],
        },
      },
    };
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/v1/ai/plan')) {
        return jsonResponse(choiceProposal);
      }

      if (url.endsWith('/v1/ai/undo')) {
        return jsonResponse({
          ok: false,
          refused: true,
          reason: 'precondition_failed',
          message:
            'The record changed after that action, so it was not reversed. Undo is still available.',
        });
      }

      return jsonResponse({
        ok: true,
        results: [
          {
            tool: 'update_record',
            status: 'updated',
            record: {
              id: 'company_north',
              objectName: 'company',
              label: 'Acme',
            },
          },
        ],
        undo: {
          id: 'undo_33333333-3333-4333-8333-333333333333',
          summary: 'Undo 1 field change.',
        },
      });
    });

    renderBar(fetchImpl, true);

    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company named Acme set city to Lisbon',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(
      await screen.findByText('north.example · Lisbon'),
    ).toBeInTheDocument();
    expect(screen.getByText('south.example · Porto')).toBeInTheDocument();
    expect(screen.getByText('New record')).toBeInTheDocument();

    await user.click(
      screen.getByRole('radio', { name: /north\.example · Lisbon/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText(
        'The record changed after that action, so it was not reversed. Undo is still available.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });
});

describe('side panel and several choices', () => {
  it('sends the record open in the side panel when the page is a list', async () => {
    const user = userEvent.setup();
    const store = createStore();
    store.set(sidePanelNavigationStackState.atom, [
      {
        page: SidePanelPages.RoutedPage,
        pageTitle: 'Ada',
        pageIcon: () => null,
        pageId: 'panel-page',
        routedLocation: {
          pathname: '/object/person/person_side',
          search: '',
          hash: '',
          state: null,
          key: 'side',
        },
      },
    ] as never);
    const fetchImpl = jest.fn(async () => jsonResponse(proposal));

    render(
      <Provider store={store}>
        <I18nProvider i18n={i18n}>
          <MemoryRouter initialEntries={['/objects/people']}>
            <AiCommandBar config={config} fetchImpl={fetchImpl} initialOpen />
          </MemoryRouter>
        </I18nProvider>
      </Provider>,
    );

    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveAttribute(
      'placeholder',
      'Add a note to this person: Followed up',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'add a note',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    const planCall = (
      fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit?]>
    ).find((call) => String(call[0]).endsWith('/v1/ai/plan'));

    expect(JSON.parse(String(planCall?.[1]?.body))).toEqual({
      workspaceId: 'ws_demo',
      intent: 'add a note',
      context: { objectName: 'person', recordId: 'person_side' },
    });
  });

  it('asks for every ambiguous name before confirm', async () => {
    const user = userEvent.setup();
    const choiceProposal = {
      ok: true,
      workspaceId: 'ws_demo',
      proposal: {
        id: 'proposal_22222222-2222-4222-8222-222222222222',
        summary: 'Choose a person and a company.',
        tools: [],
        lines: [
          { tool: 'update_record', summary: 'Choose a person and a company.' },
        ],
        choice: {
          prompt: 'Choose a person and a company.',
          candidates: [
            {
              id: 'person_north',
              label: 'Ada North',
              objectName: 'person',
              action: 'use',
            },
            {
              id: 'person_south',
              label: 'Ada South',
              objectName: 'person',
              action: 'use',
            },
          ],
          groups: [
            {
              id: '0',
              prompt: 'Several people match “Ada”. Choose one, then confirm.',
              candidates: [
                {
                  id: 'person_north',
                  label: 'Ada North',
                  objectName: 'person',
                  action: 'use',
                },
                {
                  id: 'person_south',
                  label: 'Ada South',
                  objectName: 'person',
                  action: 'use',
                },
              ],
            },
            {
              id: '1',
              prompt:
                'Several companies match “Acme”. Choose one, then confirm.',
              candidates: [
                {
                  id: 'company_north',
                  label: 'Acme North',
                  objectName: 'company',
                  action: 'use',
                },
                {
                  id: 'company_south',
                  label: 'Acme South',
                  objectName: 'company',
                  action: 'use',
                },
              ],
            },
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
      'update both',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(await screen.findByText(/Several people match/)).toBeInTheDocument();
    expect(screen.getByText(/Several companies match/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Ada North' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Acme South' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    const actCall = (
      fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit?]>
    ).find((call) => String(call[0]).endsWith('/v1/ai/act'));

    expect(JSON.parse(String(actCall?.[1]?.body))).toMatchObject({
      choices: { '0': 'person_north', '1': 'company_south' },
    });
  });

  it('undoes the newest act and keeps the older one available', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/v1/ai/plan')) {
        return jsonResponse(proposal);
      }

      if (url.endsWith('/v1/ai/undo')) {
        return jsonResponse({
          ok: true,
          summary: 'Reversed the last confirmed change.',
          undo: {
            id: 'undo_44444444-4444-4444-8444-444444444444',
            summary: 'Undo 1 field change.',
          },
          undos: [
            {
              id: 'undo_44444444-4444-4444-8444-444444444444',
              summary: 'Undo 1 field change.',
            },
          ],
        });
      }

      return jsonResponse({
        ...created,
        undo: {
          id: 'undo_33333333-3333-4333-8333-333333333333',
          summary: 'Undo 1 field change.',
        },
        undos: [
          {
            id: 'undo_33333333-3333-4333-8333-333333333333',
            summary: 'Undo 1 field change.',
          },
          {
            id: 'undo_44444444-4444-4444-8444-444444444444',
            summary: 'Undo 1 created record.',
          },
        ],
      });
    });

    renderBar(fetchImpl, true);
    await user.type(screen.getByRole('textbox', { name: 'Command' }), INTENT);
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Undo 1 created record.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByText(
        'Undone. The next recent change can still be reversed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
  });

  it('shows tool calls while the model is planning, then settles into confirm', async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const fetchImpl = jest.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            encoder.encode(
              `event: partial\ndata: ${JSON.stringify({
                partial: true,
                lines: [
                  {
                    tool: 'create_company',
                    summary: 'Planning create_company…',
                  },
                ],
              })}\n\n`,
            ),
          );
        },
      });

      return {
        headers: {
          get: () => 'text/event-stream',
        },
        body: stream,
      } as unknown as Response;
    });

    renderBar(fetchImpl, true);
    await user.type(screen.getByRole('textbox', { name: 'Command' }), INTENT);
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(
      await screen.findByText('Planning create_company…'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(`event: proposal\ndata: ${JSON.stringify(proposal)}\n\n`),
    );
    streamController?.close();

    expect(
      await screen.findByRole('button', { name: 'Confirm' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Create company "Acme Corp".')).toBeInTheDocument();
    expect(
      screen.queryByText('Planning create_company…'),
    ).not.toBeInTheDocument();
  });
});

const CITY_CHANGE = {
  recordId: 'company_1',
  objectName: 'company',
  label: 'Acme',
  field: 'city',
  metadataField: 'address',
  current: 'Lisbon',
  proposed: 'Faro',
  summary: 'Current city “Lisbon”. Proposed “Faro”.',
};

const updateProposal = {
  ok: true,
  workspaceId: 'ws_demo',
  proposal: {
    id: 'proposal_22222222-2222-4222-8222-222222222222',
    summary: 'Set company Acme city to “Faro”.',
    tools: [
      {
        name: 'update_record',
        args: {
          object: 'company',
          id: 'company_1',
          field: 'city',
          value: 'Faro',
        },
      },
    ],
    lines: [
      { tool: 'update_record', summary: 'Set company Acme city to “Faro”.' },
    ],
    changes: [CITY_CHANGE],
    warnings: [
      {
        code: 'duplicate_email',
        message:
          'Another person already uses ada@analytical.example (Ada Lovelace). This preview still proposes that email.',
      },
    ],
  },
};

describe('round 7 preview', () => {
  afterEach(() => {
    act(() => {
      getDefaultStore().set(aiCommandBarFieldPreviewState.atom, []);
    });
  });

  it('shows current against proposed, a warning, and the same diff beside the field', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async () => jsonResponse(updateProposal));

    render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter>
          <AiCommandBar config={config} fetchImpl={fetchImpl} initialOpen />
          <AiRecordFieldPreview recordId="company_1" fieldName="address" />
        </MemoryRouter>
      </I18nProvider>,
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(
      await screen.findByText('Current city “Lisbon”. Proposed “Faro”.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/city: Current city/)).toBeInTheDocument();
    expect(
      screen.getByText(/Another person already uses ada@analytical.example/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
  });

  it('blocks confirm when the row moved', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/ai/plan')) {
        return jsonResponse(updateProposal);
      }

      return jsonResponse({
        ok: false,
        refused: true,
        reason: 'precondition_failed',
        message: 'Current city “Porto”. Proposed “Faro”. Confirm is blocked.',
        stale: [
          {
            ...CITY_CHANGE,
            current: 'Porto',
            summary: 'Current city “Porto”. Proposed “Faro”.',
          },
        ],
      });
    });

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText(
        'Current city “Porto”. Proposed “Faro”. Confirm is blocked.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers a read without a confirm button', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        ok: true,
        workspaceId: 'ws_demo',
        summary: 'Read notes on the open record. 1 match.',
        answer: {
          summary: 'Read notes on the open record. 1 match.',
          records: [
            {
              id: 'note_1',
              objectName: 'note',
              label: 'Buyer call',
              detail: 'Talked about the pilot',
            },
          ],
        },
      }),
    );

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'what happened with this deal',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(await screen.findByText(/Buyer call/)).toBeInTheDocument();
    expect(screen.getByText('Nothing was changed.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
  });

  it('shows each bulk row as it settles', async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const bulkProposal = {
      ...updateProposal,
      proposal: {
        ...updateProposal.proposal,
        tools: [
          ...updateProposal.proposal.tools,
          {
            name: 'update_record',
            args: {
              object: 'company',
              id: 'company_2',
              field: 'city',
              value: 'Faro',
            },
          },
        ],
        warnings: undefined,
      },
    };
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/v1/ai/plan')) {
          return jsonResponse(bulkProposal);
        }

        const headers = new Headers(init?.headers);
        expect(headers.get('accept')).toBe('text/event-stream');
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              encoder.encode(
                `event: progress\ndata: ${JSON.stringify({
                  index: 1,
                  total: 2,
                  label: 'Acme North',
                  status: 'updated',
                })}\n\n`,
              ),
            );
          },
        });

        return {
          headers: { get: () => 'text/event-stream' },
          body: stream,
        } as unknown as Response;
      },
    );

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update all companies named Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    expect(
      await screen.findByText('Updated Acme North (1 of 2).'),
    ).toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(
        `event: result\ndata: ${JSON.stringify({
          ...created,
          undo: {
            id: 'undo_55555555-5555-4555-8555-555555555555',
            summary: 'Undo 2 field changes.',
          },
        })}\n\n`,
      ),
    );
    streamController?.close();

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});

describe('round 8 command bar', () => {
  afterEach(() => {
    act(() => {
      getDefaultStore().set(aiCommandBarFieldPreviewState.atom, []);
    });
  });

  it('reloads a blocked preview into a new confirm', async () => {
    const user = userEvent.setup();
    const reloadedId = 'proposal_33333333-3333-4333-8333-333333333333';
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith('/v1/ai/plan')) {
          return jsonResponse(updateProposal);
        }

        if (url.endsWith('/v1/ai/repropose')) {
          return jsonResponse({
            ...updateProposal,
            proposal: {
              ...updateProposal.proposal,
              id: reloadedId,
              changes: [
                {
                  ...CITY_CHANGE,
                  current: 'Porto',
                  summary: 'Current city “Porto”. Proposed “Faro”.',
                },
              ],
            },
          });
        }

        return jsonResponse({
          ok: false,
          refused: true,
          reason: 'precondition_failed',
          message: 'Current city “Porto”. Proposed “Faro”. Confirm is blocked.',
          stale: [
            {
              ...CITY_CHANGE,
              current: 'Porto',
              summary: 'Current city “Porto”. Proposed “Faro”.',
            },
          ],
        });
      },
    );

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Reload preview' }));

    expect(
      await screen.findByText('Current city “Porto”. Proposed “Faro”.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Confirm is blocked/)).toBeInTheDocument();

    const actBodies = fetchImpl.mock.calls
      .filter(([input]) => String(input).endsWith('/v1/ai/act'))
      .map(
        ([, init]) => JSON.parse(String(init?.body)) as { proposalId?: string },
      );

    expect(actBodies[1]?.proposalId).toBe(reloadedId);
  });

  it('saves a confirmed plan and runs it behind confirm', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};

        if (url.endsWith('/v1/ai/plan') && body.skillId) {
          return jsonResponse(updateProposal);
        }

        if (url.endsWith('/v1/ai/plan')) {
          return jsonResponse(updateProposal);
        }

        if (url.endsWith('/v1/ai/skills') && init?.method === 'GET') {
          return jsonResponse({
            ok: true,
            skills: [
              {
                id: 'skill_44444444-4444-4444-8444-444444444444',
                name: 'Move Acme',
                tools: ['update_record'],
              },
            ],
          });
        }

        if (url.endsWith('/v1/ai/skills')) {
          expect(body).toEqual({
            workspaceId: 'ws_demo',
            skillName: 'Move Acme',
            confirmedPlanId: 'confirmed_55555555-5555-4555-8555-555555555555',
          });
          expect(body).not.toHaveProperty('summary');

          return jsonResponse({
            ok: true,
            summary: 'Saved skill Move Acme.',
            skill: {
              id: 'skill_44444444-4444-4444-8444-444444444444',
              name: 'Move Acme',
              tools: ['update_record'],
            },
          });
        }

        return jsonResponse({
          ok: true,
          workspaceId: 'ws_demo',
          results: [],
          confirmedPlanId: 'confirmed_55555555-5555-4555-8555-555555555555',
          undo: { id: 'undo_1', summary: 'Undo 1 field change.' },
        });
      },
    );

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Skill name' }),
      'Move Acme',
    );
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    expect(
      await screen.findByText(
        'Saved. Run it from Saved skills. Confirm still applies.',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: /AI command/ }));
    await user.click(screen.getByRole('button', { name: 'Saved skills' }));
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    expect(
      await screen.findByRole('button', { name: 'Confirm' }),
    ).toBeEnabled();

    const skillPlan = fetchImpl.mock.calls.find(([input, init]) => {
      if (!String(input).endsWith('/v1/ai/plan') || !init?.body) {
        return false;
      }

      const body = JSON.parse(String(init.body)) as { skillId?: string };

      return body.skillId === 'skill_44444444-4444-4444-8444-444444444444';
    });

    expect(skillPlan).toBeDefined();
  });

  it('previews a card without creating until confirm', async () => {
    const user = userEvent.setup();
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};

        if (url.endsWith('/v1/ai/plan')) {
          expect(body.capture).toEqual({
            source: 'voice',
            text: 'person Ada Lovelace at Analytical Engines',
          });
          expect(body).not.toHaveProperty('intent');

          return jsonResponse({
            ...proposal,
            proposal: {
              ...proposal.proposal,
              summary:
                'Create company “Analytical Engines”. Create person Ada Lovelace.',
            },
          });
        }

        return jsonResponse({
          ok: true,
          workspaceId: 'ws_demo',
          results: [],
        });
      },
    );

    renderBar(fetchImpl, true);
    await user.click(screen.getByRole('button', { name: 'Card or voice' }));
    await user.click(screen.getByRole('radio', { name: 'Voice' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Card or dictation' }),
      'person Ada Lovelace at Analytical Engines',
    );
    await user.click(screen.getByRole('button', { name: 'Preview capture' }));
    expect(
      await screen.findByRole('button', { name: 'Confirm' }),
    ).toBeEnabled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shows each bulk row and both parts of a composite field', () => {
    getDefaultStore().set(aiCommandBarFieldPreviewState.atom, [
      CITY_CHANGE,
      {
        ...CITY_CHANGE,
        recordId: 'company_2',
        label: 'Northwind',
        summary: 'Current city “Lisbon”. Proposed “Faro”.',
      },
      {
        recordId: 'company_1',
        objectName: 'company',
        label: 'Acme',
        field: 'address',
        metadataField: 'address',
        current: '1 Dock',
        proposed: '12 Analytical Way',
        summary: 'Current address “1 Dock”. Proposed “12 Analytical Way”.',
      },
    ]);

    render(
      <I18nProvider i18n={i18n}>
        <FieldContext.Provider
          value={
            {
              recordId: 'company_1',
              fieldDefinition: { metadata: { fieldName: 'address' } },
            } as GenericFieldContextType
          }
        >
          <AiRecordTableFieldPreview />
        </FieldContext.Provider>
        <FieldContext.Provider
          value={
            {
              recordId: 'company_2',
              fieldDefinition: { metadata: { fieldName: 'address' } },
            } as GenericFieldContextType
          }
        >
          <AiRecordTableFieldPreview />
        </FieldContext.Provider>
        <AiRecordFieldPreview recordId="company_1" fieldName="address" />
      </I18nProvider>,
    );

    expect(screen.getAllByText('Proposed city: Faro')).toHaveLength(2);
    expect(
      screen.getByText('Proposed address: 12 Analytical Way'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/address: Current address “1 Dock”/),
    ).toBeInTheDocument();
    expect(screen.getByText(/city: Current city “Lisbon”/)).toBeInTheDocument();
  });
});

describe('round 9 command bar', () => {
  it('shows each timeline record as the read stream arrives', async () => {
    const user = userEvent.setup();
    const encoder = new TextEncoder();
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const fetchImpl = jest.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            encoder.encode(
              `event: read\ndata: ${JSON.stringify({
                tool: 'search_notes',
                summary: 'Read notes on the open record',
                records: [
                  {
                    id: 'note_1',
                    objectName: 'note',
                    label: 'Buyer call',
                    detail: 'Talked about the pilot',
                  },
                ],
              })}\n\n`,
            ),
          );
        },
      });

      return {
        headers: { get: () => 'text/event-stream' },
        body: stream,
      } as unknown as Response;
    });

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'what happened with this deal',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    expect(await screen.findByText(/Buyer call/)).toBeInTheDocument();
    expect(screen.queryByText(/Send proposal/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(
        `event: read\ndata: ${JSON.stringify({
          tool: 'search_tasks',
          summary: 'Read tasks on the open record',
          records: [
            {
              id: 'task_1',
              objectName: 'task',
              label: 'Send proposal',
            },
          ],
        })}\n\n`,
      ),
    );

    expect(await screen.findByText('Send proposal')).toBeInTheDocument();

    streamController?.enqueue(
      encoder.encode(
        `event: proposal\ndata: ${JSON.stringify({
          ok: true,
          workspaceId: 'ws_demo',
          summary: 'Read notes. 2 matches.',
          answer: {
            summary: 'Read notes. 2 matches.',
            records: [
              {
                id: 'note_1',
                objectName: 'note',
                label: 'Buyer call',
                detail: 'Talked about the pilot',
              },
              { id: 'task_1', objectName: 'task', label: 'Send proposal' },
            ],
          },
        })}\n\n`,
      ),
    );
    streamController?.close();

    expect(
      await screen.findByText('Read notes. 2 matches.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Confirm' }),
    ).not.toBeInTheDocument();
  });

  it('leaves city blank on a saved skill and fills it before confirm', async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        bodies.push(body);

        if (url.endsWith('/v1/ai/skills') && init?.method !== 'GET') {
          return jsonResponse({
            ok: true,
            skill: {
              id: 'skill_44444444-4444-4444-8444-444444444444',
              name: 'Move city',
              tools: ['update_record'],
              parameters: ['city'],
            },
          });
        }

        if (url.endsWith('/v1/ai/skills')) {
          return jsonResponse({
            ok: true,
            skills: [
              {
                id: 'skill_44444444-4444-4444-8444-444444444444',
                name: 'Move city',
                tools: ['update_record'],
                parameters: ['city'],
              },
            ],
          });
        }

        if (url.endsWith('/v1/ai/plan') && body.parameterValues) {
          return jsonResponse(updateProposal);
        }

        if (url.endsWith('/v1/ai/plan')) {
          return jsonResponse(updateProposal);
        }

        return jsonResponse({
          ok: true,
          workspaceId: 'ws_demo',
          results: [],
          confirmedPlanId: 'confirmed_55555555-5555-4555-8555-555555555555',
        });
      },
    );

    renderBar(fetchImpl, true);
    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'update company Acme set city to Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Skill name' }),
      'Move city',
    );
    await user.click(screen.getByRole('checkbox', { name: 'City' }));
    await user.click(screen.getByRole('button', { name: 'Save skill' }));
    expect(
      bodies.some((body) => {
        const blanks = body.blanks;

        return Array.isArray(blanks) && blanks.includes('city');
      }),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: /AI command/ }));
    await user.click(screen.getByRole('button', { name: 'Saved skills' }));
    await user.click(await screen.findByRole('button', { name: 'Run' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'City' }),
      'Faro',
    );
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(
      await screen.findByRole('button', { name: 'Confirm' }),
    ).toBeEnabled();
    const filled = bodies.find((body) => isPlainParameter(body));
    expect(filled?.parameterValues).toEqual({ city: 'Faro' });
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  it('draws a proposed person and company on the record table', () => {
    getDefaultStore().set(aiCommandBarCreatePreviewState.atom, [
      {
        objectName: 'person',
        label: 'Ada Lovelace',
        summary: 'ada@analytical.example',
      },
      {
        objectName: 'company',
        label: 'Analytical Engines',
        summary: 'analytical.example',
      },
    ]);

    render(
      <I18nProvider i18n={i18n}>
        <AiRecordTableGhostRows objectName="person" />
        <AiRecordTableGhostRows objectName="company" />
        <AiRecordTableGhostRows objectName="opportunity" />
      </I18nProvider>,
    );

    expect(
      screen.getByRole('row', { name: /Proposed person Ada Lovelace/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: /Proposed company Analytical Engines/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('does not keep another record id on a ghost row', async () => {
    getDefaultStore().set(aiCommandBarCreatePreviewState.atom, []);
    const user = userEvent.setup();
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        ok: true,
        workspaceId: 'ws_demo',
        proposal: {
          id: 'proposal_11111111-1111-4111-8111-111111111111',
          summary: 'Create person Ada Lovelace.',
          tools: [
            {
              name: 'create_person',
              args: { firstName: 'Ada', lastName: 'Lovelace' },
            },
          ],
          lines: [
            {
              tool: 'create_person',
              summary: 'Create person Ada Lovelace.',
            },
          ],
          creates: [
            {
              objectName: 'person',
              label: 'Ada Lovelace',
              summary: 'ada@analytical.example',
              id: 'person_victim',
            },
          ],
        },
      }),
    );

    render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter>
          <AiCommandBar config={config} fetchImpl={fetchImpl} initialOpen />
          <AiRecordTableGhostRows objectName="person" />
        </MemoryRouter>
      </I18nProvider>,
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Command' }),
      'create person Ada Lovelace',
    );
    await user.click(screen.getByRole('button', { name: 'Propose' }));

    const row = await screen.findByRole('row', {
      name: /Proposed person Ada Lovelace/,
    });

    expect(row).not.toHaveAttribute('data-selectable-id');
    expect(row).not.toHaveAttribute('data-record-table-record-id');
    expect(document.body.textContent).not.toContain('person_victim');
  });
});

const isPlainParameter = (body: Record<string, unknown>): boolean =>
  typeof body.parameterValues === 'object' && body.parameterValues !== null;

describe('readOpenRecordFromPath', () => {
  it('reads a person, company, or opportunity show page', () => {
    expect(readOpenRecordFromPath('/object/opportunity/opp_1')).toEqual({
      objectName: 'opportunity',
      recordId: 'opp_1',
    });
    expect(readOpenRecordFromPath('/object/person/person_1/timeline')).toEqual({
      objectName: 'person',
      recordId: 'person_1',
    });
    expect(readOpenRecordFromPath('/objects/companies')).toBeUndefined();
    expect(readOpenRecordFromPath('/object/note/note_1')).toBeUndefined();
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
