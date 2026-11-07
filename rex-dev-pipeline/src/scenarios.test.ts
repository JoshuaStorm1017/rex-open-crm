import { describe, expect, it } from 'vitest';

import { runScenario, SCENARIO_NAMES } from './scenarios';

describe('dry-run scenarios', () => {
  it('covers the pilot paths without live effects', async () => {
    const reports = [];

    for (const name of SCENARIO_NAMES) {
      reports.push(await runScenario(name));
    }

    expect(
      reports.map((report) => [report.scenario, report.state, report.reason]),
    ).toEqual([
      ['happy', 'verified', undefined],
      ['test-failure', 'blocked', 'tests_failed'],
      ['review-repair', 'failed', 'repair_cap'],
      ['paused', 'paused', 'usage_envelope_missing'],
      ['uncertain-launch', 'implementation', undefined],
      ['cap', 'failed', 'cap_exhausted'],
    ]);
    expect(reports.every((report) => report.engineeringCapsNotDollarCaps)).toBe(
      true,
    );
    expect(reports.every((report) => report.liveEffectsEnabled === false)).toBe(
      true,
    );
    expect(
      reports.find((report) => report.scenario === 'happy')?.simulatedMerge,
    ).toBe(true);
    expect(
      reports.find((report) => report.scenario === 'uncertain-launch')
        ?.dispatchCount,
    ).toBe(1);
    expect(
      reports.find((report) => report.scenario === 'paused')?.dispatchCount,
    ).toBe(0);
  });
});
