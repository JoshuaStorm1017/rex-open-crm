import {
  ScriptedAdapter,
  type ScriptedPlan,
} from './adapters/scripted-adapter';
import { DevPipeline } from './engine';
import { createLog } from './redact';
import type { CreateRunInput, EffectRequest } from './types';

const OWNER = 'owner-1';
const WRITER = 'writer-1';
const REVIEWER = 'reviewer-1';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const NEXT = 'c'.repeat(40);

export const SCENARIO_NAMES = [
  'happy',
  'test-failure',
  'review-repair',
  'paused',
  'uncertain-launch',
  'cap',
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export type ScenarioReport = {
  scenario: ScenarioName;
  state: string;
  reason?: string;
  version: number;
  agentRuns: number;
  repairAttempts: number;
  dispatchCount: number;
  liveEffectsEnabled: boolean;
  engineeringCapsNotDollarCaps: true;
  simulatedMerge: boolean;
};

export async function runScenario(name: ScenarioName): Promise<ScenarioReport> {
  const adapter = new ScriptedAdapter(plansFor(name));
  const pipeline = DevPipeline.open({
    adapter,
    clock: { now: () => 1_000 },
    log: createLog(),
    ids: sequentialIds(),
  });
  const created = pipeline.createRun(inputFor(name));

  if (!created.ok) {
    pipeline.close();
    throw new Error(created.reason);
  }

  let pumped = await pipeline.pump(created.runId);

  if (name === 'uncertain-launch') {
    pumped = await pipeline.pump(created.runId);
  }

  if (name === 'happy' && pumped.state === 'human_merge_approval') {
    pipeline.submitApproval(created.runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 60_000,
    });
    pumped = await pipeline.pump(created.runId);
  }

  const inspection = pipeline.inspect(created.runId);
  const reason =
    pumped.reason ??
    inspection.pausedReason ??
    inspection.failReason ??
    inspection.blockReason ??
    undefined;
  const report: ScenarioReport = {
    scenario: name,
    state: inspection.state,
    ...(reason ? { reason } : {}),
    version: inspection.version,
    agentRuns: inspection.agentRuns,
    repairAttempts: inspection.repairAttempts,
    dispatchCount: adapter.calls.length,
    liveEffectsEnabled: inspection.liveEffectsEnabled,
    engineeringCapsNotDollarCaps: true,
    simulatedMerge: inspection.ledger.some(
      (entry) =>
        entry.kind === 'guarded_merge' &&
        entry.status === 'applied' &&
        entry.simulated,
    ),
  };
  pipeline.close();
  return report;
}

export function isScenarioName(value: string): value is ScenarioName {
  return SCENARIO_NAMES.some((name) => name === value);
}

function plansFor(name: ScenarioName): ScriptedPlan[] {
  if (name === 'test-failure') {
    return [
      writer(HEAD),
      tests({ exitCode: 2, passed: 0, failed: 1 }),
      review('accept'),
      merge(),
    ];
  }

  if (name === 'review-repair') {
    return [
      writer(HEAD),
      tests(),
      review('reject'),
      writerFollowUp(NEXT),
      tests(),
      review('reject'),
    ];
  }

  if (name === 'uncertain-launch') {
    return [
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'unknown',
        record: true,
        externalId: 'sim-landed',
      },
    ];
  }

  if (name === 'paused' || name === 'cap') {
    return [writer(HEAD), tests(), review('accept'), merge()];
  }

  return [writer(HEAD), tests(), review('accept'), merge()];
}

function inputFor(name: ScenarioName): CreateRunInput {
  return {
    objective: 'Add a fictional demo label to the example repository.',
    acceptance: ['The label renders for ws_demo.'],
    sources: [
      {
        kind: 'intake',
        ref: 'task:demo-label',
        sha: BASE,
        capturedAt: '2026-11-07T00:00:00.000Z',
      },
    ],
    repository: 'https://github.com/example/rex-demo',
    baseRef: 'main',
    baseSha: BASE,
    ownerId: OWNER,
    writerId: WRITER,
    reviewerId: REVIEWER,
    usageEnvelope: name === 'paused' ? null : { acknowledged: true },
    limits:
      name === 'review-repair'
        ? { maxRepairAttempts: 1 }
        : name === 'cap'
          ? { maxAgentRuns: 1 }
          : undefined,
  };
}

function writer(commitSha: string): ScriptedPlan {
  return {
    kind: 'agent_launch',
    role: 'writer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => artifact(request, commitSha),
  };
}

function writerFollowUp(commitSha: string): ScriptedPlan {
  return {
    kind: 'agent_follow_up',
    role: 'writer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => artifact(request, commitSha),
  };
}

function tests(patch?: {
  exitCode: number;
  passed: number;
  failed: number;
}): ScriptedPlan {
  return {
    kind: 'trusted_tests',
    role: 'test',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => ({
      kind: 'test_evidence',
      commitSha: request.headSha,
      command: 'tsc --noEmit && vitest run src/demo-label.test.ts',
      exitCode: patch?.exitCode ?? 0,
      passed: patch?.passed ?? 3,
      failed: patch?.failed ?? 0,
      outputDigest: 'digest-demo',
    }),
  };
}

function review(verdict: 'accept' | 'reject'): ScriptedPlan {
  return {
    kind: 'agent_launch',
    role: 'reviewer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => ({
      kind: 'review',
      commitSha: request.headSha,
      reviewerId: request.reviewerId,
      writerId: request.writerId,
      verdict,
      findings:
        verdict === 'reject'
          ? ['The demo label is missing its empty state.']
          : [],
    }),
  };
}

function merge(): ScriptedPlan {
  return {
    kind: 'guarded_merge',
    role: 'merge',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => ({
      kind: 'merge',
      commitSha: request.headSha,
      verified: true,
    }),
  };
}

function artifact(request: EffectRequest, commitSha: string) {
  return {
    kind: 'implementation' as const,
    writerId: request.writerId,
    commitSha,
    summary: 'Add the fictional demo label',
    filesChanged: ['src/demo-label.ts'],
    contextId: request.contextId,
    contextVersion: request.contextVersion,
    contextHash: request.contextHash,
  };
}

function sequentialIds(): () => string {
  let count = 0;
  return () => `id-${++count}`;
}
