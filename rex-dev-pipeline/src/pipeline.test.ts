import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ScriptedAdapter,
  type ScriptedPlan,
} from './adapters/scripted-adapter';
import { DevPipeline, type PipelineHooks } from './engine';
import { createLog } from './redact';
import {
  isDocumentedTransition,
  PIPELINE_EDGES,
  PIPELINE_NODES,
} from './graph';
import type {
  ContextSource,
  CreateRunInput,
  EffectRequest,
  ImplementationArtifact,
  MergeArtifact,
  ReviewArtifact,
  TestEvidence,
} from './types';

const OWNER = 'owner-1';
const WRITER = 'writer-1';
const REVIEWER = 'reviewer-1';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const NEXT = 'c'.repeat(40);
const SECRET = 'sk-test-secret-value';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('dev pipeline', () => {
  it('walks the happy path on simulated adapters', async () => {
    const clock = manualClock();
    const adapter = new ScriptedAdapter(happyPlans());
    const pipeline = open(adapter, clock);
    const created = pipeline.createRun(input());
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const pumped = await pipeline.pump(created.runId);
    expect(pumped.state).toBe('human_merge_approval');
    const approval = pipeline.submitApproval(created.runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: clock.now() + 60_000,
    });
    expect(approval.ok).toBe(true);
    const merged = await pipeline.pump(created.runId);
    expect(merged.state).toBe('verified');

    const inspection = pipeline.inspect(created.runId);
    expect(inspection.engineeringCapsNotDollarCaps).toBe(true);
    expect(inspection.limits).toEqual({
      maxWriters: 1,
      maxRepairAttempts: 2,
      maxAgentRuns: 7,
      maxActiveMinutes: 90,
    });
    expect(inspection.liveEffectsEnabled).toBe(false);
    expect(inspection.evidence.tests).toMatchObject({
      commitSha: HEAD,
      fresh: true,
    });
    expect(inspection.evidence.review).toMatchObject({
      commitSha: HEAD,
      reviewerId: REVIEWER,
      fresh: true,
    });
    expect(inspection.evidence.approval).toMatchObject({
      commitSha: HEAD,
      fresh: true,
    });
    expect(inspection.ledger.map((entry) => entry.kind)).toEqual([
      'agent_launch',
      'trusted_tests',
      'agent_launch',
      'guarded_merge',
    ]);
    expect(
      inspection.ledger.every((entry) => entry.simulated && !entry.live),
    ).toBe(true);
    expect(inspection.outbox.length).toBeGreaterThan(0);
    expect(inspection.attempts.length).toBeGreaterThan(0);
    expect(inspection.contract?.contextReused).toBe(false);

    const states = inspection.versions.map((version) => version.state);
    expect(states).toEqual([
      'authorized_intake',
      'pinned_contract',
      'implementation',
      'trusted_tests',
      'independent_review',
      'human_merge_approval',
      'guarded_merge',
      'verified',
    ]);

    for (let index = 1; index < states.length; index += 1) {
      const from = states[index - 1];
      const to = states[index];
      expect(from && to && isDocumentedTransition(from, to)).toBe(true);
    }

    pipeline.close();
  });

  it('blocks review and merge when compile or tests fail', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan({ exitCode: 2, passed: 0, failed: 1, command: 'tsc --noEmit' }),
      reviewPlan('accept'),
      mergePlan(),
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const pumped = await pipeline.pump(runId);
    expect(pumped.state).toBe('blocked');
    expect(pumped.reason).toBe('tests_failed');
    expect(adapter.calls.some((call) => call.role === 'reviewer')).toBe(false);
    const merge = await pipeline.requestMerge(runId);
    expect(merge.state).toBe('blocked');
    expect(merge.reason).toBe('tests_failed');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    pipeline.close();
  });

  it('refuses an untrusted YES attestation', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      { kind: 'trusted_tests', role: 'test', outcome: 'accepted' },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const effectId = pipeline.inspect(runId).ledger.at(-1)?.id ?? '';
    const refused = pipeline.deliverCompletion({
      id: 'yes-attestation',
      effectId,
      artifact: { kind: 'test_evidence', result: 'YES' },
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('untrusted_attestation');
    expect(pipeline.inspect(runId).state).toBe('trusted_tests');
    expect(adapter.calls.some((call) => call.role === 'reviewer')).toBe(false);
    pipeline.close();
  });

  it('repairs a rejected review and stops at the repair cap', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      reviewPlan('reject'),
      followUpPlan(NEXT),
      testPlan(),
      reviewPlan('reject'),
      followUpPlan('d'.repeat(40)),
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline, { limits: { maxRepairAttempts: 1 } });
    const pumped = await pipeline.pump(runId);
    expect(pumped.state).toBe('failed');
    expect(pumped.reason).toBe('repair_cap');
    expect(
      adapter.calls.filter((call) => call.kind === 'agent_follow_up'),
    ).toHaveLength(1);
    expect(pipeline.inspect(runId).repairAttempts).toBe(1);
    const followUp = adapter.calls.find(
      (call) => call.kind === 'agent_follow_up',
    );
    const writerLaunch = adapter.calls.find((call) => call.role === 'writer');
    expect(followUp?.writerExternalId).toBe(
      writerLaunch ? `sim-${writerLaunch.clientToken}` : '',
    );
    pipeline.close();
  });

  it('refuses stale sha evidence and approval after a code change', async () => {
    const adapter = new ScriptedAdapter([
      ...happyPlans(),
      { kind: 'trusted_tests', role: 'test', outcome: 'accepted' },
      reviewPlan('accept'),
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const advanced = pipeline.advanceCommit(runId, NEXT);
    expect(advanced.ok).toBe(true);
    expect(pipeline.inspect(runId).evidence.tests?.fresh).toBe(false);
    expect(pipeline.inspect(runId).evidence.review?.fresh).toBe(false);
    const waited = await pipeline.pump(runId);
    expect(waited.stopped).toBe('awaiting_result');
    const effectId = pipeline.inspect(runId).ledger.at(-1)?.id ?? '';
    const stale = pipeline.deliverCompletion({
      id: 'stale-tests',
      effectId,
      artifact: evidence(HEAD, { exitCode: 0, passed: 1, failed: 0 }),
    });
    expect(stale.reason).toBe('stale_sha');
    const staleApproval = pipeline.submitApproval(runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 60_000,
    });
    expect(staleApproval.reason).toBe('stale_sha');
    const merge = await pipeline.requestMerge(runId);
    expect(merge.state).not.toBe('verified');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    const fresh = pipeline.deliverCompletion({
      id: 'fresh-tests',
      effectId,
      artifact: evidence(NEXT, { exitCode: 0, passed: 2, failed: 0 }),
    });
    expect(fresh.ok).toBe(true);
    expect(pipeline.inspect(runId).state).toBe('independent_review');
    pipeline.close();
  });

  it('refuses a writer self-review', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      {
        kind: 'agent_launch',
        role: 'reviewer',
        outcome: 'accepted',
        externalId: 'sim-review',
        artifact: (request: EffectRequest) => review(request, 'accept', WRITER),
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const pumped = await pipeline.pump(runId);
    expect(pumped.stopped).toBe('result_refused');
    expect(pumped.reason).toBe('writer_cannot_review');
    expect(pipeline.inspect(runId).state).toBe('independent_review');
    const merge = await pipeline.requestMerge(runId);
    expect(merge.state).toBe('independent_review');
    pipeline.close();
  });

  it('refuses a different writer on the implementation artifact', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        artifact: (request: EffectRequest) => ({
          ...implementation(request, HEAD),
          writerId: 'writer-2',
        }),
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const pumped = await pipeline.pump(runId);
    expect(pumped.reason).toBe('writer_not_allowed');
    expect(pipeline.inspect(runId).state).not.toBe('trusted_tests');
    pipeline.close();
  });

  it('requires a fresh owner approval before simulated merge', async () => {
    const clock = manualClock();
    const pipeline = open(new ScriptedAdapter(happyPlans()), clock);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const missing = await pipeline.requestMerge(runId);
    expect(missing.state).toBe('blocked');
    expect(missing.reason).toBe('approval_missing');
    const expired = pipeline.submitApproval(runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: clock.now() - 1,
    });
    expect(expired.reason).toBe('approval_expired');
    expect(
      pipeline
        .inspect(runId)
        .ledger.some((entry) => entry.kind === 'guarded_merge'),
    ).toBe(false);
    pipeline.close();
  });

  it('expires an approval that was valid when it was recorded', async () => {
    const clock = manualClock();
    const adapter = new ScriptedAdapter(happyPlans());
    const pipeline = open(adapter, clock);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    pipeline.submitApproval(runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 5_000,
    });
    clock.set(5_000);
    const merged = await pipeline.pump(runId);
    expect(merged.state).toBe('blocked');
    expect(merged.reason).toBe('approval_expired');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    pipeline.close();
  });

  it('does not simulate a live merge when live effects are enabled', async () => {
    const adapter = new ScriptedAdapter(happyPlans());
    const clock = manualClock();
    const pipeline = open(adapter, clock);
    const runId = mustCreate(pipeline, { liveEffectsEnabled: true });
    await pipeline.pump(runId);
    pipeline.submitApproval(runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 60_000,
    });
    const merged = await pipeline.pump(runId);
    expect(merged.state).toBe('blocked');
    expect(merged.reason).toBe('live_merge_not_wired');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    const suppressed = pipeline
      .inspect(runId)
      .ledger.find((entry) => entry.kind === 'guarded_merge');
    expect(suppressed?.status).toBe('suppressed');
    expect(suppressed?.live).toBe(false);
    pipeline.close();
  });

  it('pauses without an envelope and blocks effects while paused', async () => {
    const adapter = new ScriptedAdapter(happyPlans());
    const pipeline = open(adapter);
    const missing = pipeline.createRun(input({ usageEnvelope: null }));
    expect(missing.ok).toBe(true);
    if (!missing.ok) {
      return;
    }

    const paused = await pipeline.pump(missing.runId);
    expect(paused.state).toBe('paused');
    expect(adapter.calls).toHaveLength(0);
    expect(pipeline.resume(missing.runId).reason).toBe(
      'usage_envelope_missing',
    );
    pipeline.close();

    const live = open(adapter);
    const created = live.createRun(input());
    if (!created.ok) {
      return;
    }

    live.pause(created.runId, 'operator');
    const held = await live.pump(created.runId);
    expect(held.state).toBe('paused');
    expect(adapter.calls).toHaveLength(0);
    expect(live.resume(created.runId).ok).toBe(true);
    const continued = await live.pump(created.runId);
    expect(continued.state).toBe('human_merge_approval');
    expect(adapter.calls.length).toBeGreaterThan(0);
    live.close();
  });

  it('reconciles an unknown launch instead of retrying it', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'unknown',
        record: true,
        externalId: 'sim-landed',
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const first = await pipeline.pump(runId);
    expect(first.state).toBe('reconciling');
    expect(adapter.calls).toHaveLength(1);
    const retry = pipeline.requestRedispatch(runId);
    expect(retry.status).toBe('reconcile_required');
    expect(adapter.calls).toHaveLength(1);
    const second = await pipeline.pump(runId);
    expect(second.state).toBe('implementation');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.trace).toEqual(['dispatch', 'reconcile']);
    pipeline.close();
  });

  it('reconciles an unknown follow-up instead of sending it twice', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      reviewPlan('reject'),
      {
        kind: 'agent_follow_up',
        role: 'writer',
        outcome: 'unknown',
        record: true,
        externalId: 'sim-follow-up',
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const first = await pipeline.pump(runId);
    expect(first.state).toBe('reconciling');
    const followUps = () =>
      adapter.calls.filter((call) => call.kind === 'agent_follow_up').length;
    expect(followUps()).toBe(1);
    expect(pipeline.requestRedispatch(runId).status).toBe('reconcile_required');
    expect(followUps()).toBe(1);
    const second = await pipeline.pump(runId);
    expect(second.state).toBe('implementation');
    expect(followUps()).toBe(1);
    pipeline.close();
  });

  it('sends again only after reconciliation says the launch is absent', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'unknown',
        record: false,
      },
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        externalId: 'sim-retry',
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    await pipeline.pump(runId);
    expect(adapter.trace.slice(0, 3)).toEqual([
      'dispatch',
      'reconcile',
      'dispatch',
    ]);
    expect(adapter.calls).toHaveLength(2);
    pipeline.close();
  });

  it('recovers a recorded unknown launch after the process restarts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'rex-dev-pipeline-'));
    directories.push(directory);
    const filename = path.join(directory, 'pipeline.sqlite');
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'unknown',
        record: true,
        externalId: 'sim-restart',
      },
    ]);
    const first = open(adapter, manualClock(), { filename });
    const runId = mustCreate(first);
    await first.pump(runId);
    expect(first.inspect(runId).state).toBe('reconciling');
    first.close();

    const second = open(adapter, manualClock(), { filename });
    const recovered = await second.pump(runId);
    expect(recovered.state).toBe('implementation');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.reconcileCalls).toHaveLength(1);
    second.close();
  });

  it('treats a halt before send as reconciliation, then a single dispatch', async () => {
    let halted = false;
    const hooks: PipelineHooks = {
      afterIntended: () => {
        if (halted) {
          return 'continue';
        }

        halted = true;
        return 'halt';
      },
    };
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        externalId: 'sim-after-halt',
      },
    ]);
    const pipeline = open(adapter, manualClock(), { hooks });
    const runId = mustCreate(pipeline);
    const interrupted = await pipeline.pump(runId);
    expect(interrupted.stopped).toBe('interrupted');
    expect(adapter.calls).toHaveLength(0);
    await pipeline.pump(runId);
    expect(adapter.trace[0]).toBe('reconcile');
    expect(adapter.calls).toHaveLength(1);
    pipeline.close();
  });

  it('applies an out-of-order completion once', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        externalId: 'sim-early',
        beforeReturn: (request, sink) => {
          sink.deliverCompletion({
            id: 'early-result',
            effectId: request.effectId,
            artifact: implementation(request, HEAD),
          });
        },
        artifact: (request: EffectRequest) => implementation(request, HEAD),
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const inspection = pipeline.inspect(runId);
    expect(
      inspection.attempts.filter(
        (attempt) => attempt.kind === 'implementation',
      ),
    ).toHaveLength(1);
    expect(
      inspection.versions.filter(
        (version) => version.state === 'trusted_tests',
      ),
    ).toHaveLength(1);
    pipeline.close();
  });

  it('ignores a duplicate completion and a duplicate delivery', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        externalId: 'sim-wait',
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const effectId = pipeline.inspect(runId).ledger[0]?.id ?? '';
    const request = adapter.calls[0];
    expect(request).toBeDefined();
    if (!request) {
      return;
    }

    const first = pipeline.deliverCompletion({
      id: 'completion-1',
      effectId,
      artifact: implementation(request, HEAD),
    });
    const version = pipeline.inspect(runId).version;
    const second = pipeline.deliverCompletion({
      id: 'completion-1',
      effectId,
      artifact: implementation(request, HEAD),
    });
    expect(first.ok).toBe(true);
    expect(second.status).toBe('duplicate');
    expect(pipeline.inspect(runId).version).toBe(version);
    expect(pipeline.redeliver(runId, effectId).status).toBe('duplicate');
    expect(adapter.calls).toHaveLength(1);
    pipeline.close();
  });

  it('fails closed when the agent-run or active-minute cap is exhausted', async () => {
    const runs = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      reviewPlan('accept'),
    ]);
    const capped = open(runs);
    const runId = mustCreate(capped, { limits: { maxAgentRuns: 1 } });
    const pumped = await capped.pump(runId);
    expect(pumped.state).toBe('failed');
    expect(pumped.reason).toBe('cap_exhausted');
    expect(runs.calls.some((call) => call.role === 'reviewer')).toBe(false);
    capped.close();

    const clock = manualClock();
    const minutes = new ScriptedAdapter([writerPlan(HEAD)]);
    const timed = open(minutes, clock);
    const timedRun = mustCreate(timed, { limits: { maxActiveMinutes: 1 } });
    clock.set(61_000);
    const expired = await timed.pump(timedRun);
    expect(expired.state).toBe('failed');
    expect(expired.reason).toBe('cap_exhausted');
    expect(minutes.calls).toHaveLength(0);
    timed.close();
  });

  it('clamps configured limits to the pilot maximums', async () => {
    const pipeline = open(new ScriptedAdapter([]));
    const runId = mustCreate(pipeline, {
      limits: { maxRepairAttempts: 9, maxAgentRuns: 40, maxActiveMinutes: 500 },
    });
    expect(pipeline.inspect(runId).limits).toEqual({
      maxWriters: 1,
      maxRepairAttempts: 2,
      maxAgentRuns: 7,
      maxActiveMinutes: 90,
    });
    pipeline.close();
  });

  it('reuses a pinned context and refuses a stale one after invalidation', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'agent_launch', role: 'writer', outcome: 'accepted' },
      { kind: 'agent_launch', role: 'writer', outcome: 'accepted' },
      { kind: 'agent_launch', role: 'writer', outcome: 'accepted' },
    ]);
    const pipeline = open(adapter);
    const firstId = mustCreate(pipeline);
    await pipeline.pump(firstId);
    const firstContext = pipeline.inspect(firstId).contract;
    const secondId = mustCreate(pipeline);
    await pipeline.pump(secondId);
    const secondContract = pipeline.inspect(secondId).contract;
    expect(secondContract?.contextReused).toBe(true);
    expect(secondContract?.contextId).toBe(firstContext?.contextId);
    expect(secondContract?.contextVersion).toBe(firstContext?.contextVersion);

    const invalidated = pipeline.invalidateContext(firstId, 'source changed');
    expect(invalidated.reason).toBe('context_invalidated');
    const effectId = pipeline.inspect(firstId).ledger[0]?.id ?? '';
    const request = adapter.calls[0];
    expect(request).toBeDefined();
    if (!request) {
      return;
    }

    const stale = pipeline.deliverCompletion({
      id: 'stale-context',
      effectId,
      artifact: implementation(request, HEAD),
    });
    expect(stale.reason).toBe('stale_context');
    const thirdId = mustCreate(pipeline);
    await pipeline.pump(thirdId);
    const thirdContract = pipeline.inspect(thirdId).contract;
    expect(thirdContract?.contextReused).toBe(false);
    expect(thirdContract?.contextId).toBe(firstContext?.contextId);
    expect(thirdContract?.contextVersion).toBe(2);
    pipeline.close();
  });

  it('does not write secrets into logs, inspection, or the state file', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'rex-dev-pipeline-secret-'),
    );
    directories.push(directory);
    const filename = path.join(directory, 'pipeline.sqlite');
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      {
        kind: 'agent_launch',
        role: 'reviewer',
        outcome: 'accepted',
        artifact: (request: EffectRequest) => ({
          ...review(request, 'accept'),
          findings: [`token ${SECRET}`, `api_key=${SECRET}`],
        }),
      },
    ]);
    const pipeline = open(adapter, manualClock(), { filename });
    const runId = mustCreate(pipeline, {
      objective: `Add a label. Authorization: Bearer ${SECRET}`,
    });
    pipeline.logDiagnostic(`provider said Authorization: Bearer ${SECRET}`);
    await pipeline.pump(runId);
    const inspection = JSON.stringify(pipeline.inspect(runId));
    const logs = pipeline.logs().join('\n');
    pipeline.close();
    const dumped = [filename, `${filename}-wal`, `${filename}-shm`]
      .map((candidate) => {
        try {
          return readFileSync(candidate, 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(logs).not.toContain(SECRET);
    expect(inspection).not.toContain(SECRET);
    expect(dumped).not.toContain(SECRET);
    expect(logs).toContain('[redacted]');
  });

  it('keeps routine transitions in code', () => {
    expect(PIPELINE_EDGES.every((edge) => edge.decidedBy === 'code')).toBe(
      true,
    );
    expect(
      PIPELINE_NODES.filter((node) => node.reasoning === 'model').map(
        (node) => node.state,
      ),
    ).toEqual(['implementation', 'independent_review', 'bounded_repair']);
    expect(isDocumentedTransition('pinned_contract', 'reconciling')).toBe(
      true,
    );
    expect(isDocumentedTransition('reconciling', 'pinned_contract')).toBe(
      true,
    );
    expect(isDocumentedTransition('guarded_merge', 'reconciling')).toBe(true);
    expect(isDocumentedTransition('reconciling', 'guarded_merge')).toBe(true);
    expect(
      isDocumentedTransition('trusted_tests', 'human_merge_approval'),
    ).toBe(false);
    expect(isDocumentedTransition('blocked', 'trusted_tests')).toBe(false);
    expect(isDocumentedTransition('verified', 'blocked')).toBe(false);
    expect(isDocumentedTransition('paused', 'verified')).toBe(false);
    expect(isDocumentedTransition('pinned_contract', 'verified')).toBe(false);
  });

  it('does not accept a review or merge artifact on the wrong effect', async () => {
    const reviewOnTest = new ScriptedAdapter([
      writerPlan(HEAD),
      {
        kind: 'trusted_tests',
        role: 'test',
        outcome: 'accepted',
        artifact: (request: EffectRequest) => review(request, 'accept'),
      },
      reviewPlan('accept'),
      mergePlan(),
    ]);
    const pipeline = open(reviewOnTest);
    const runId = mustCreate(pipeline);
    const pumped = await pipeline.pump(runId);
    expect(pumped.reason).toBe('artifact_effect_mismatch');
    expect(pumped.state).toBe('trusted_tests');
    expect(reviewOnTest.calls.some((call) => call.role === 'reviewer')).toBe(
      false,
    );
    expect((await pipeline.requestMerge(runId)).state).toBe('trusted_tests');
    pipeline.close();

    const mergeOnReview = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      {
        kind: 'agent_launch',
        role: 'reviewer',
        outcome: 'accepted',
        artifact: (request: EffectRequest): MergeArtifact => ({
          kind: 'merge',
          commitSha: request.headSha ?? HEAD,
          verified: true,
        }),
      },
    ]);
    const second = open(mergeOnReview);
    const secondId = mustCreate(second);
    const reviewed = await second.pump(secondId);
    expect(reviewed.reason).toBe('artifact_effect_mismatch');
    expect(second.inspect(secondId).state).toBe('independent_review');
    expect(reviewed.state).not.toBe('verified');
    second.close();
  });

  it('does not let the writer effect approve its own change', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'agent_launch', role: 'writer', outcome: 'accepted' },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    expect(pipeline.inspect(runId).state).toBe('implementation');
    expect(pipeline.advanceCommit(runId, NEXT).reason).toBe(
      'commit_change_refused',
    );
    expect(pipeline.inspect(runId).state).toBe('implementation');
    const request = adapter.calls[0];
    expect(request).toBeDefined();
    if (!request) {
      return;
    }

    const delivered = pipeline.deliverCompletion({
      id: 'writer-review',
      effectId: pipeline.inspect(runId).ledger[0]?.id ?? '',
      artifact: review(request, 'accept'),
    });
    expect(delivered.reason).toBe('artifact_effect_mismatch');
    expect(pipeline.inspect(runId).state).toBe('implementation');
    pipeline.close();
  });

  it('refuses a reviewer launch that reuses the writer agent', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'accepted',
        externalId: 'same-agent',
        artifact: (request: EffectRequest) => implementation(request, HEAD),
      },
      testPlan(),
      {
        kind: 'agent_launch',
        role: 'reviewer',
        outcome: 'accepted',
        externalId: 'same-agent',
        artifact: (request: EffectRequest) => review(request, 'accept'),
      },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    const pumped = await pipeline.pump(runId);
    expect(pumped.reason).toBe('writer_cannot_review');
    expect(pipeline.inspect(runId).state).toBe('independent_review');
    expect((await pipeline.requestMerge(runId)).state).not.toBe('verified');
    pipeline.close();
  });

  it('keeps a test failure blocked when the commit is advanced', async () => {
    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan({ exitCode: 2, passed: 0, failed: 1 }),
      reviewPlan('accept'),
      mergePlan(),
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    expect((await pipeline.pump(runId)).reason).toBe('tests_failed');
    expect(pipeline.advanceCommit(runId, NEXT).reason).toBe(
      'commit_change_refused',
    );
    expect(pipeline.inspect(runId).state).toBe('blocked');
    const merge = await pipeline.requestMerge(runId);
    expect(merge.state).toBe('blocked');
    expect(merge.reason).toBe('tests_failed');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    pipeline.close();
  });

  it('does not merge a run whose context was invalidated after approval', async () => {
    const adapter = new ScriptedAdapter(happyPlans());
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    expect(
      pipeline.submitApproval(runId, {
        approverId: OWNER,
        commitSha: HEAD,
        effect: 'guarded_merge',
        expiresAt: 60_000,
      }).ok,
    ).toBe(true);
    expect(pipeline.invalidateContext(runId, 'source changed').reason).toBe(
      'context_invalidated',
    );
    const merged = await pipeline.requestMerge(runId);
    expect(merged.state).toBe('blocked');
    expect(merged.reason).toBe('context_invalidated');
    expect(adapter.calls.some((call) => call.kind === 'guarded_merge')).toBe(
      false,
    );
    pipeline.close();
  });

  it('keeps verified terminal and ignores pause-time invalidation', async () => {
    const adapter = new ScriptedAdapter(happyPlans());
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    pipeline.submitApproval(runId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 60_000,
    });
    expect((await pipeline.pump(runId)).state).toBe('verified');
    expect(pipeline.invalidateContext(runId, 'later').reason).toBe('terminal');
    expect(pipeline.pause(runId, 'operator').reason).toBe('terminal');
    expect(pipeline.inspect(runId).state).toBe('verified');
    pipeline.close();

    const waiting = new ScriptedAdapter([
      { kind: 'agent_launch', role: 'writer', outcome: 'accepted' },
    ]);
    const paused = open(waiting);
    const pausedId = mustCreate(paused);
    await paused.pump(pausedId);
    paused.pause(pausedId, 'operator');
    expect(paused.invalidateContext(pausedId, 'later').reason).toBe(
      'paused_no_effect',
    );
    expect(paused.inspect(pausedId).state).toBe('paused');
    paused.close();
  });

  it('holds an in-flight launch when the operator pauses', async () => {
    const holder: { pipeline?: DevPipeline; runId?: string } = {};
    const adapter = new ScriptedAdapter([
      {
        kind: 'agent_launch',
        role: 'writer',
        outcome: 'unknown',
        record: true,
        externalId: 'sim-landed',
        beforeReturn: () => {
          if (holder.pipeline && holder.runId) {
            holder.pipeline.pause(holder.runId, 'operator');
          }
        },
      },
    ]);
    const pipeline = open(adapter);
    holder.pipeline = pipeline;
    const runId = mustCreate(pipeline);
    holder.runId = runId;
    const first = await pipeline.pump(runId);
    expect(first.state).toBe('paused');
    expect(first.reason).toBe('paused_no_effect');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.trace).toEqual(['dispatch']);
    expect(
      pipeline.inspect(runId).versions.map((version) => version.state),
    ).not.toContain('reconciling');
    expect((await pipeline.pump(runId)).state).toBe('paused');
    expect(adapter.trace).toEqual(['dispatch']);
    expect(pipeline.resume(runId).ok).toBe(true);
    const continued = await pipeline.pump(runId);
    expect(continued.state).toBe('implementation');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.trace).toEqual(['dispatch', 'reconcile']);
    pipeline.close();
  });

  it('refuses a non-owner, a non-finite expiry, and a YES review', async () => {
    const approvals = open(new ScriptedAdapter(happyPlans()));
    const approvalId = mustCreate(approvals);
    await approvals.pump(approvalId);
    const stranger = approvals.submitApproval(approvalId, {
      approverId: 'intruder',
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: 60_000,
    });
    expect(stranger.reason).toBe('approver_not_owner');
    expect(stranger.state).toBe('human_merge_approval');
    const forever = approvals.submitApproval(approvalId, {
      approverId: OWNER,
      commitSha: HEAD,
      effect: 'guarded_merge',
      expiresAt: Number.POSITIVE_INFINITY,
    });
    expect(forever.reason).toBe('approval_expiry_invalid');
    expect(approvals.inspect(approvalId).state).toBe('human_merge_approval');
    approvals.close();

    const adapter = new ScriptedAdapter([
      writerPlan(HEAD),
      testPlan(),
      { kind: 'agent_launch', role: 'reviewer', outcome: 'accepted' },
    ]);
    const pipeline = open(adapter);
    const runId = mustCreate(pipeline);
    await pipeline.pump(runId);
    const effectId = pipeline.inspect(runId).ledger.at(-1)?.id ?? '';
    const yes = pipeline.deliverCompletion({
      id: 'yes-review',
      effectId,
      artifact: {
        kind: 'review',
        commitSha: HEAD,
        reviewerId: REVIEWER,
        writerId: WRITER,
        verdict: 'YES',
        findings: [],
      },
    });
    expect(yes.reason).toBe('review_artifact_invalid');
    expect(pipeline.inspect(runId).state).toBe('independent_review');
    pipeline.close();
  });

  it('redacts cursor-shaped and slack-shaped tokens', () => {
    const log = createLog();
    log.write(
      'crsr_abcdefghijklmnopqrstuvwxyz key_abcdefghijklmnopqrstuvwxyz xoxb-1234567890-abcdef',
    );
    const line = log.lines.join('\n');
    expect(line).not.toContain('crsr_abcdefghijklmnopqrstuvwxyz');
    expect(line).not.toContain('key_abcdefghijklmnopqrstuvwxyz');
    expect(line).not.toContain('xoxb-1234567890-abcdef');
    expect(line).toContain('[redacted]');
  });
});

function happyPlans(): ScriptedPlan[] {
  return [writerPlan(HEAD), testPlan(), reviewPlan('accept'), mergePlan()];
}

function writerPlan(commitSha: string): ScriptedPlan {
  return {
    kind: 'agent_launch',
    role: 'writer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => implementation(request, commitSha),
  };
}

function followUpPlan(commitSha: string): ScriptedPlan {
  return {
    kind: 'agent_follow_up',
    role: 'writer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => implementation(request, commitSha),
  };
}

function testPlan(patch?: Partial<TestEvidence>): ScriptedPlan {
  return {
    kind: 'trusted_tests',
    role: 'test',
    outcome: 'accepted',
    artifact: (request: EffectRequest) =>
      evidence(request.headSha ?? HEAD, {
        exitCode: 0,
        passed: 3,
        failed: 0,
        ...patch,
      }),
  };
}

function reviewPlan(verdict: 'accept' | 'reject'): ScriptedPlan {
  return {
    kind: 'agent_launch',
    role: 'reviewer',
    outcome: 'accepted',
    artifact: (request: EffectRequest) => review(request, verdict),
  };
}

function mergePlan(): ScriptedPlan {
  return {
    kind: 'guarded_merge',
    role: 'merge',
    outcome: 'accepted',
    artifact: (request: EffectRequest): MergeArtifact => ({
      kind: 'merge',
      commitSha: request.headSha ?? HEAD,
      verified: true,
    }),
  };
}

function implementation(
  request: EffectRequest,
  commitSha: string,
): ImplementationArtifact {
  return {
    kind: 'implementation',
    writerId: request.writerId,
    commitSha,
    summary: 'Add the fictional demo label',
    filesChanged: ['src/demo-label.ts'],
    contextId: request.contextId,
    contextVersion: request.contextVersion,
    contextHash: request.contextHash,
  };
}

function evidence(
  commitSha: string,
  patch: Partial<TestEvidence> & {
    exitCode: number;
    passed: number;
    failed: number;
  },
): TestEvidence {
  return {
    kind: 'test_evidence',
    commitSha,
    command:
      patch.command ?? 'tsc --noEmit && vitest run src/demo-label.test.ts',
    exitCode: patch.exitCode,
    passed: patch.passed,
    failed: patch.failed,
    outputDigest: patch.outputDigest ?? 'digest-demo',
  };
}

function review(
  request: EffectRequest,
  verdict: 'accept' | 'reject',
  reviewerId = request.reviewerId,
): ReviewArtifact {
  return {
    kind: 'review',
    commitSha: request.headSha ?? HEAD,
    reviewerId,
    writerId: request.writerId,
    verdict,
    findings:
      verdict === 'reject'
        ? ['The demo label is missing its empty state.']
        : [],
  };
}

function input(overrides: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    objective: 'Add a fictional demo label to the example repository.',
    acceptance: ['The label renders for ws_demo.'],
    sources: sources(),
    repository: 'https://github.com/example/rex-demo',
    baseRef: 'main',
    baseSha: BASE,
    ownerId: OWNER,
    writerId: WRITER,
    reviewerId: REVIEWER,
    usageEnvelope: { acknowledged: true },
    ...overrides,
  };
}

function sources(): ContextSource[] {
  return [
    {
      kind: 'intake',
      ref: 'task:demo-label',
      sha: BASE,
      capturedAt: '2026-11-07T00:00:00.000Z',
    },
  ];
}

function open(
  adapter: ScriptedAdapter,
  clock = manualClock(),
  options: { filename?: string; hooks?: PipelineHooks } = {},
): DevPipeline {
  return DevPipeline.open({
    adapter,
    clock,
    ids: sequentialIds(),
    log: createLog(),
    ...(options.filename ? { filename: options.filename } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
}

function mustCreate(
  pipeline: DevPipeline,
  overrides: Partial<CreateRunInput> = {},
): string {
  const created = pipeline.createRun(input(overrides));
  if (!created.ok) {
    throw new Error(created.reason);
  }

  return created.runId;
}

function manualClock(start = 1_000): {
  now: () => number;
  set: (value: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function sequentialIds(): () => string {
  let count = 0;
  return () => `id-${++count}`;
}
