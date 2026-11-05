import { describe, expect, it } from 'vitest';

import {
  applyStreamLine,
  createStreamState,
  snapshotToolCalls,
} from './openai-llm-provider';

describe('openai tool call stream', () => {
  it('emits a partial tool call before the arguments are complete JSON', () => {
    const state = createStreamState();

    applyStreamLine(
      state,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"create_person","arguments":""}}]}}]}',
    );
    expect(snapshotToolCalls(state)).toEqual([
      { name: 'create_person', args: {}, complete: false },
    ]);

    applyStreamLine(
      state,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"firstName\\":\\"Ada\\""}}]}}]}',
    );
    expect(snapshotToolCalls(state)[0]?.complete).toBe(false);

    applyStreamLine(
      state,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"lastName\\":\\"Lovelace\\"}"}}]}}]}',
    );

    expect(snapshotToolCalls(state)).toEqual([
      {
        name: 'create_person',
        args: { firstName: 'Ada', lastName: 'Lovelace' },
        complete: true,
      },
    ]);
  });
});
