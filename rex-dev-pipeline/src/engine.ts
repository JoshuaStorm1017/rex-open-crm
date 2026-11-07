import { randomUUID } from 'node:crypto';

import type { PipelineAdapter } from './adapters/types';
import { hashSources } from './context';
import { parseArtifact } from './evidence';
import { formatGraphText } from './graph';
import { buildPrompt } from './prompt';
import { createLog, redactValue, type PipelineLog } from './redact';
import { PipelineStore } from './store';
import {
  isActiveState,
  isCommitSha,
  isTerminalState,
  resolveLimits,
  type ApplyResult,
  type ApprovalInput,
  type ApprovalRecord,
  type ArtifactPayload,
  type CompletionEvent,
  type ContextSource,
  type CreateRunInput,
  type EffectRecord,
  type EffectRequest,
  type EffectRole,
  type EffectStatus,
  type Inspection,
  type PipelineState,
  type PumpResult,
  type RunRecord,
  type StopReason,
  type TaskContext,
  type TaskContract,
} from './types';

export type PipelineHooks = {
  afterIntended?: (effect: { id: string }) => 'halt' | 'continue';
};

export type OpenPipelineOptions = {
  filename?: string;
  adapter: PipelineAdapter;
  clock?: { now: () => number };
  ids?: () => string;
  log?: PipelineLog;
  hooks?: PipelineHooks;
};

type Decision =
  | { type: 'pin' }
  | { type: 'dispatch'; kind: EffectRecord['kind']; role: EffectRole }
  | { type: 'reconcile'; effectId: string }
  | { type: 'stop'; reason: StopReason }
  | { type: 'fail'; reason: string }
  | { type: 'block'; reason: string };

const RESUMABLE_BLOCKS = new Set([
  'approval_missing',
  'approval_expired',
  'context_invalidated',
]);

export class DevPipeline {
  private constructor(
    private readonly store: PipelineStore,
    private readonly adapter: PipelineAdapter,
    private readonly clock: { now: () => number },
    private readonly ids: () => string,
    private readonly log: PipelineLog,
    private readonly hooks: PipelineHooks,
  ) {}

  static open(options: OpenPipelineOptions): DevPipeline {
    return new DevPipeline(
      new PipelineStore(options.filename ?? ':memory:'),
      options.adapter,
      options.clock ?? { now: () => Date.now() },
      options.ids ?? (() => randomUUID()),
      options.log ?? createLog(),
      options.hooks ?? {},
    );
  }

  createRun(
    input: CreateRunInput,
  ): { ok: true; runId: string } | { ok: false; reason: string } {
    const reason = validateCreate(input);

    if (reason) {
      return { ok: false, reason };
    }

    const now = this.now();
    const envelope =
      input.usageEnvelope?.acknowledged === true
        ? { acknowledged: true as const }
        : null;
    const run: RunRecord = {
      id: this.ids(),
      state: envelope ? 'authorized_intake' : 'paused',
      version: 1,
      config: {
        ownerId: input.ownerId,
        writerId: input.writerId,
        reviewerId: input.reviewerId,
        repository: input.repository,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        objective: input.objective,
        acceptance: input.acceptance,
        sources: input.sources,
        liveEffectsEnabled: input.liveEffectsEnabled === true,
        limits: resolveLimits(input.limits),
        usageEnvelope: envelope,
        engineeringCapsNotDollarCaps: true,
      },
      contract: null,
      contextId: null,
      headSha: null,
      writerExternalId: null,
      repairAttempts: 0,
      agentRuns: 0,
      activeMs: 0,
      lastTickAt: now,
      pausedFrom: envelope ? null : 'authorized_intake',
      blockReason: null,
      failReason: null,
      pausedReason: envelope ? null : 'usage_envelope_missing',
      createdAt: now,
      updatedAt: now,
    };

    this.store.transaction(() => {
      this.store.insertRun(run);
      this.store.appendVersion({
        runId: run.id,
        version: 1,
        state: run.state,
        reason: envelope ? 'authorized_intake' : 'usage_envelope_missing',
        at: now,
      });
    });
    this.log.write(`run ${run.id} created ${run.state}`);

    return { ok: true, runId: run.id };
  }

  async pump(runId: string): Promise<PumpResult> {
    const dispatched: string[] = [];

    for (let step = 0; step < 30; step += 1) {
      let run = this.must(runId);
      run = this.tick(run);

      if (run.state === 'paused') {
        return this.stopped(
          run,
          run.pausedReason === 'usage_envelope_missing'
            ? 'envelope_missing'
            : 'paused',
          dispatched,
        );
      }

      if (run.state === 'failed') {
        return this.stopped(
          run,
          'failed',
          dispatched,
          run.failReason ?? undefined,
        );
      }

      if (run.state === 'blocked') {
        return this.stopped(
          run,
          'blocked',
          dispatched,
          run.blockReason ?? undefined,
        );
      }

      if (run.state === 'verified') {
        return this.stopped(run, 'verified', dispatched);
      }

      const decision = this.decide(run);

      if (decision.type === 'stop') {
        return this.stopped(run, decision.reason, dispatched);
      }

      if (decision.type === 'fail') {
        const failed = this.fail(run, decision.reason);
        return this.stopped(failed, 'failed', dispatched, decision.reason);
      }

      if (decision.type === 'block') {
        if (decision.reason === 'live_merge_not_wired') {
          this.suppressMerge(run, decision.reason);
        } else {
          this.block(run, decision.reason);
        }

        return this.stopped(
          this.must(runId),
          'blocked',
          dispatched,
          decision.reason,
        );
      }

      if (decision.type === 'pin') {
        this.pin(run);
        continue;
      }

      if (decision.type === 'reconcile') {
        const action = await this.reconcile(decision.effectId);
        if (action === 'stay') {
          return this.stopped(this.must(runId), 'reconciling', dispatched);
        }

        continue;
      }

      const sent = await this.dispatch(run, decision.kind, decision.role);
      if (sent.effectId) {
        dispatched.push(sent.effectId);
      }

      if (sent.stop) {
        return this.stopped(
          this.must(runId),
          sent.stop,
          dispatched,
          sent.reason,
        );
      }
    }

    return this.stopped(this.must(runId), 'step_budget', dispatched);
  }

  submitApproval(runId: string, input: ApprovalInput): ApplyResult {
    const run = this.must(runId);

    if (run.state === 'paused') {
      return this.refuse(run, 'paused_no_effect', 'approval');
    }

    if (!run.headSha || input.commitSha !== run.headSha) {
      return this.refuse(run, 'stale_sha', 'approval');
    }

    const waiting =
      run.state === 'human_merge_approval' ||
      (run.state === 'blocked' &&
        (run.blockReason === 'approval_missing' ||
          run.blockReason === 'approval_expired'));

    if (!waiting) {
      return this.refuse(run, 'approval_not_due', 'approval');
    }

    if (input.approverId !== run.config.ownerId) {
      return this.refuse(run, 'approver_not_owner', 'approval');
    }

    if (input.effect !== 'guarded_merge') {
      return this.refuse(run, 'approval_effect_invalid', 'approval');
    }

    if (input.expiresAt <= this.now()) {
      this.block(run, 'approval_expired');
      return this.refuse(this.must(runId), 'approval_expired', 'approval');
    }

    const approval: ApprovalRecord = {
      id: input.id ?? this.ids(),
      runId,
      commitSha: input.commitSha,
      approverId: input.approverId,
      effect: 'guarded_merge',
      approvedAt: this.now(),
      expiresAt: input.expiresAt,
    };
    this.store.insertApproval(approval);
    const next = this.transition(
      { ...run, blockReason: null },
      'guarded_merge',
      'owner_approval',
    );

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
    };
  }

  async requestMerge(runId: string): Promise<PumpResult> {
    const run = this.must(runId);

    if (run.state === 'paused') {
      return this.stopped(run, 'paused', [], 'paused_no_effect');
    }

    if (run.state === 'failed' || run.state === 'verified') {
      return this.stopped(
        run,
        run.state === 'verified' ? 'verified' : 'failed',
        [],
      );
    }

    const approval = this.freshApproval(run);

    if (!approval) {
      const reason = this.approvalProblem(run);

      if (
        run.state === 'human_merge_approval' ||
        run.state === 'guarded_merge'
      ) {
        this.block(run, reason);
        return this.stopped(this.must(runId), 'blocked', [], reason);
      }

      return this.stopped(
        run,
        run.state === 'blocked' ? 'blocked' : 'awaiting_approval',
        [],
        run.blockReason ?? reason,
      );
    }

    if (run.state !== 'guarded_merge') {
      this.transition(run, 'guarded_merge', 'owner_approval');
    }

    return this.pump(runId);
  }

  pause(runId: string, reason: string): ApplyResult {
    const run = this.tick(this.must(runId));

    if (isTerminalState(run.state)) {
      return this.refuse(run, 'terminal', 'pause');
    }

    if (run.state === 'paused') {
      return {
        ok: true,
        status: 'duplicate',
        state: run.state,
        version: run.version,
      };
    }

    const next = this.transition(
      { ...run, pausedFrom: run.state, pausedReason: reason },
      'paused',
      'pause',
    );

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
    };
  }

  resume(runId: string): ApplyResult {
    const run = this.must(runId);

    if (run.state !== 'paused') {
      return this.refuse(run, 'not_paused', 'resume');
    }

    if (run.config.usageEnvelope?.acknowledged !== true) {
      return this.refuse(run, 'usage_envelope_missing', 'resume');
    }

    const target = run.pausedFrom ?? 'authorized_intake';
    const next = this.transition(
      { ...run, pausedReason: null, lastTickAt: this.now() },
      target,
      'resume',
    );

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
    };
  }

  advanceCommit(runId: string, commitSha: string): ApplyResult {
    const run = this.must(runId);

    if (!isCommitSha(commitSha)) {
      return this.refuse(run, 'commit_sha_invalid', 'commit_advanced');
    }

    if (
      run.state === 'paused' ||
      run.state === 'failed' ||
      run.state === 'verified'
    ) {
      return this.refuse(run, 'commit_change_refused', 'commit_advanced');
    }

    this.store.markArtifactsStale(runId);
    const next = this.transition(
      { ...run, headSha: commitSha },
      'trusted_tests',
      'commit_advanced',
    );

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
    };
  }

  invalidateContext(runId: string, reason: string): ApplyResult {
    const run = this.must(runId);
    const contract = run.contract;

    if (!contract) {
      return this.refuse(run, 'contract_missing', 'invalidate_context');
    }

    this.store.invalidateContext(
      contract.contextId,
      contract.contextVersion,
      this.now(),
      reason,
    );
    this.store.markArtifactsStale(runId);
    const next = this.block(run, 'context_invalidated');

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
      reason: 'context_invalidated',
    };
  }

  repin(runId: string, sources: ContextSource[]): ApplyResult {
    const run = this.must(runId);

    if (run.state === 'paused') {
      return this.refuse(run, 'paused_no_effect', 'repin_context');
    }

    if (run.blockReason !== 'context_invalidated') {
      return this.refuse(run, 'repin_not_due', 'repin_context');
    }

    const pinned = this.pinContext(sources);
    const contract = this.buildContract(run, pinned.context, pinned.reused);
    const next = this.transition(
      {
        ...run,
        config: { ...run.config, sources },
        contract,
        contextId: pinned.context.id,
        headSha: null,
        blockReason: null,
        writerExternalId: null,
      },
      'pinned_contract',
      'repin_context',
    );

    return {
      ok: true,
      status: 'applied',
      state: next.state,
      version: next.version,
    };
  }

  deliverCompletion(event: CompletionEvent): ApplyResult {
    const existing = this.store.findEvent(event.id);

    if (existing && existing.status !== 'queued') {
      return { ...asApplyResult(existing.result), status: 'duplicate' };
    }

    const effect = this.findCompletionEffect(event);

    if (!effect) {
      const queued: ApplyResult = { ok: true, status: 'queued' };
      this.rememberEvent(
        event.id,
        'inbox',
        'completion',
        event,
        'queued',
        queued,
      );
      this.store.insertInbox({
        eventId: event.id,
        ...(event.effectId ? { effectId: event.effectId } : {}),
        ...(event.clientToken ? { clientToken: event.clientToken } : {}),
        payload: event,
        receivedAt: this.now(),
      });
      return queued;
    }

    const run = this.must(effect.runId);

    if (run.state === 'paused') {
      return this.refuse(run, 'paused_no_effect', 'completion', event.id);
    }

    if (effect.terminal) {
      const duplicate: ApplyResult = {
        ok: true,
        status: 'duplicate',
        state: run.state,
        version: run.version,
      };
      this.rememberEvent(
        event.id,
        run.id,
        'completion',
        event,
        'duplicate',
        duplicate,
      );
      return duplicate;
    }

    const parsed = parseArtifact(event.artifact);

    if (!parsed.ok) {
      this.finishEffect(effect, 'refused', { reason: parsed.reason });
      return this.refuse(run, parsed.reason, 'completion', event.id);
    }

    const applied = this.applyArtifact(effect, parsed.artifact);
    this.rememberEvent(
      event.id,
      run.id,
      'completion',
      event,
      applied.ok ? 'applied' : 'refused',
      applied,
    );
    return applied;
  }

  redeliver(runId: string, effectId: string): ApplyResult {
    const run = this.must(runId);
    const effect = this.store.findEffect(effectId);

    if (!effect || effect.runId !== runId) {
      return this.refuse(run, 'effect_missing', 'redeliver');
    }

    const delivered = this.store
      .listOutbox(effectId)
      .some(
        (entry) => entry.status === 'delivered' || entry.status === 'duplicate',
      );

    if (effect.terminal || delivered) {
      return {
        ok: true,
        status: 'duplicate',
        state: run.state,
        version: run.version,
      };
    }

    return {
      ok: false,
      status: 'reconcile_required',
      reason: 'reconcile_required',
      state: run.state,
      version: run.version,
    };
  }

  requestRedispatch(runId: string): ApplyResult {
    const run = this.must(runId);
    const open = this.store.openEffect(runId);

    if (
      !open ||
      open.status === 'unknown' ||
      open.status === 'intended' ||
      open.deliveryAttempted
    ) {
      return {
        ok: false,
        status: 'reconcile_required',
        reason: 'reconcile_required',
        state: run.state,
        version: run.version,
      };
    }

    return {
      ok: false,
      status: 'reconcile_required',
      reason: 'reconcile_required',
      state: run.state,
      version: run.version,
    };
  }

  logDiagnostic(message: string): void {
    this.log.write(message);
  }

  inspect(runId: string): Inspection {
    const run = this.must(runId);
    const context = run.contract
      ? this.store.loadContext(
          run.contract.contextId,
          run.contract.contextVersion,
        )
      : undefined;
    const artifacts = this.store.listArtifacts(runId);
    const testArtifact = latestArtifact(artifacts, 'test_evidence');
    const reviewArtifact = latestArtifact(artifacts, 'review');
    const approval = this.freshApproval(run);
    const latestApproval = this.store.listApprovals(runId).at(-1);
    const resumable =
      run.state === 'paused' ||
      run.state === 'reconciling' ||
      (run.state === 'blocked' && RESUMABLE_BLOCKS.has(run.blockReason ?? ''));
    const inspection: Inspection = {
      runId,
      state: run.state,
      version: run.version,
      headSha: run.headSha,
      blockReason: run.blockReason,
      failReason: run.failReason,
      pausedReason: run.pausedReason,
      pausedFrom: run.pausedFrom,
      resumable,
      terminal:
        run.state === 'failed' ||
        run.state === 'verified' ||
        (run.state === 'blocked' && !resumable),
      engineeringCapsNotDollarCaps: true,
      limits: run.config.limits,
      usageEnvelope: run.config.usageEnvelope,
      liveEffectsEnabled: run.config.liveEffectsEnabled,
      agentRuns: run.agentRuns,
      repairAttempts: run.repairAttempts,
      activeMinutes: Math.floor(run.activeMs / 60_000),
      writerExternalId: run.writerExternalId,
      contract: run.contract,
      context: context ?? null,
      evidence: {
        tests:
          testArtifact && typeof testArtifact.commitSha === 'string'
            ? {
                commitSha: testArtifact.commitSha,
                fresh:
                  testArtifact.commitSha === run.headSha && !testArtifact.stale,
              }
            : null,
        review: reviewPayload(reviewArtifact, run.headSha),
        approval: approval
          ? {
              commitSha: approval.commitSha,
              expiresAt: approval.expiresAt,
              fresh: true,
            }
          : latestApproval
            ? {
                commitSha: latestApproval.commitSha,
                expiresAt: latestApproval.expiresAt,
                fresh: false,
              }
            : null,
      },
      ledger: this.store.listEffects(runId).map((effect) => ({
        id: effect.id,
        kind: effect.kind,
        role: effect.role,
        status: effect.status,
        terminal: effect.terminal,
        counted: effect.counted,
        clientToken: effect.clientToken,
        externalId: effect.externalId,
        attempt: effect.attempt,
        simulated: effect.request.simulated,
        live: effect.request.live,
      })),
      outbox: this.store.listRunOutbox(runId),
      versions: this.store.listVersions(runId),
      attempts: this.store.listAttempts(runId),
      graph: formatGraphText(run.state),
    };

    return redactValue(inspection) as Inspection;
  }

  logs(): readonly string[] {
    return this.log.lines;
  }

  close(): void {
    this.store.close();
  }

  private decide(run: RunRecord): Decision {
    const open = this.store.openEffect(run.id);

    if (run.state === 'reconciling') {
      if (!open) {
        return { type: 'fail', reason: 'reconcile_without_effect' };
      }

      return { type: 'reconcile', effectId: open.id };
    }

    if (open && (open.status === 'intended' || open.status === 'unknown')) {
      return { type: 'reconcile', effectId: open.id };
    }

    if (open) {
      return { type: 'stop', reason: 'awaiting_result' };
    }

    switch (run.state) {
      case 'authorized_intake':
        return run.config.usageEnvelope
          ? { type: 'pin' }
          : { type: 'stop', reason: 'envelope_missing' };
      case 'pinned_contract':
        if (run.agentRuns >= run.config.limits.maxAgentRuns) {
          return { type: 'fail', reason: 'cap_exhausted' };
        }

        return { type: 'dispatch', kind: 'agent_launch', role: 'writer' };
      case 'implementation':
        return { type: 'stop', reason: 'awaiting_result' };
      case 'trusted_tests':
        return { type: 'dispatch', kind: 'trusted_tests', role: 'test' };
      case 'independent_review':
        if (run.agentRuns >= run.config.limits.maxAgentRuns) {
          return { type: 'fail', reason: 'cap_exhausted' };
        }

        return { type: 'dispatch', kind: 'agent_launch', role: 'reviewer' };
      case 'bounded_repair':
        if (!run.writerExternalId) {
          return { type: 'fail', reason: 'writer_agent_missing' };
        }

        if (run.agentRuns >= run.config.limits.maxAgentRuns) {
          return { type: 'fail', reason: 'cap_exhausted' };
        }

        return { type: 'dispatch', kind: 'agent_follow_up', role: 'writer' };
      case 'human_merge_approval':
        return { type: 'stop', reason: 'awaiting_approval' };
      case 'guarded_merge': {
        const approval = this.freshApproval(run);

        if (!approval) {
          return { type: 'block', reason: this.approvalProblem(run) };
        }

        if (run.config.liveEffectsEnabled) {
          return { type: 'block', reason: 'live_merge_not_wired' };
        }

        return { type: 'dispatch', kind: 'guarded_merge', role: 'merge' };
      }
      default:
        return { type: 'stop', reason: 'blocked' };
    }
  }

  private async dispatch(
    run: RunRecord,
    kind: EffectRecord['kind'],
    role: EffectRole,
  ): Promise<{ effectId: string; stop?: StopReason; reason?: string }> {
    const contract = run.contract;

    if (!contract) {
      const failed = this.fail(run, 'contract_missing');
      return {
        effectId: '',
        stop: 'failed',
        reason: failed.failReason ?? 'contract_missing',
      };
    }

    let attempt =
      role === 'writer' && kind === 'agent_follow_up' ? run.repairAttempts : 0;
    let repairAttempts = run.repairAttempts;

    if (kind === 'agent_follow_up') {
      const previous = this.store.latestEffect(run.id, 'agent_follow_up');
      const retry =
        previous?.status === 'absent' &&
        previous.terminal &&
        previous.attempt === run.repairAttempts;

      if (!retry) {
        if (run.repairAttempts >= run.config.limits.maxRepairAttempts) {
          this.fail(run, 'repair_cap');
          return { effectId: '', stop: 'failed', reason: 'repair_cap' };
        }

        repairAttempts = run.repairAttempts + 1;
        attempt = repairAttempts;
      }
    } else {
      attempt =
        this.store.listEffects(run.id).filter((effect) => effect.kind === kind)
          .length + 1;
    }

    const effectId = this.ids();
    const now = this.now();
    const request: EffectRequest = {
      effectId,
      runId: run.id,
      kind,
      role,
      clientToken: `token-${effectId}`,
      intendedAt: new Date(now).toISOString(),
      writerId: run.config.writerId,
      reviewerId: run.config.reviewerId,
      ownerId: run.config.ownerId,
      repository: run.config.repository,
      baseSha: run.config.baseSha,
      headSha: run.headSha,
      contextId: contract.contextId,
      contextVersion: contract.contextVersion,
      contextHash: contract.contextHash,
      objective: contract.objective,
      acceptance: contract.acceptance,
      writerExternalId: run.writerExternalId,
      prompt: '',
      simulated: true,
      live: false,
    };
    request.prompt = buildPrompt(request);
    const effect: EffectRecord = {
      id: effectId,
      runId: run.id,
      kind,
      role,
      status: 'intended',
      clientToken: request.clientToken,
      externalId: null,
      attempt,
      deliveryAttempted: false,
      terminal: false,
      counted: false,
      request,
      outcome: null,
      createdAt: now,
    };

    this.store.transaction(() => {
      const current = this.must(run.id);
      this.store.saveRun({ ...current, repairAttempts, updatedAt: now });
      this.store.insertEffect(effect);
      this.store.insertOutbox({
        id: this.ids(),
        effectId,
        status: 'pending',
        result: null,
        createdAt: now,
      });
    });

    if (this.hooks.afterIntended?.({ id: effectId }) === 'halt') {
      return { effectId, stop: 'interrupted' };
    }

    const queued = this.store.takeInbox(effectId, request.clientToken);

    for (const item of queued) {
      this.deliverCompletion(asCompletion(item.payload));
    }

    const afterInbox = this.store.findEffect(effectId);

    if (afterInbox?.terminal) {
      this.markLatestOutbox(effectId, 'duplicate', {
        note: 'inbox completion',
      });
      return { effectId };
    }

    this.store.transaction(() => {
      const current = this.store.findEffect(effectId);

      if (!current || current.terminal) {
        return;
      }

      current.deliveryAttempted = true;
      current.status = 'unknown';
      this.store.saveEffect(current);
    });

    let result;

    try {
      result = await Promise.resolve(
        this.adapter.dispatch(request, {
          deliverCompletion: (completion) => this.deliverCompletion(completion),
        }),
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      this.log.write(`adapter dispatch failed: ${name}`);
      result = { outcome: 'unknown' as const };
    }

    const latest = this.store.findEffect(effectId);

    if (!latest) {
      return { effectId, stop: 'failed', reason: 'effect_missing' };
    }

    if (latest.terminal) {
      this.rememberExternalId(latest, result, role);
      this.markLatestOutbox(effectId, 'duplicate', {
        note: 'completion already applied',
      });
      return { effectId };
    }

    if (result.outcome === 'unknown' || result.outcome === 'conflict_exists') {
      if (result.outcome === 'conflict_exists') {
        latest.externalId = result.externalId;
      }

      latest.status = 'unknown';
      latest.outcome = { outcome: result.outcome };
      this.store.saveEffect(latest);
      this.markLatestOutbox(effectId, 'unknown', { outcome: result.outcome });
      this.transition(this.must(run.id), 'reconciling', 'outcome_unknown');
      return { effectId, stop: 'reconciling' };
    }

    if (result.outcome === 'refused') {
      this.finishEffect(latest, 'refused', { reason: result.reason });
      this.markLatestOutbox(effectId, 'delivered', result);
      return { effectId, stop: 'result_refused', reason: result.reason };
    }

    this.rememberExternalId(latest, result, role);
    this.markLatestOutbox(effectId, 'delivered', { outcome: 'accepted' });

    if (result.artifact !== undefined) {
      const applied = this.deliverCompletion({
        id: `result:${effectId}`,
        effectId,
        artifact: result.artifact,
      });

      if (!applied.ok) {
        return { effectId, stop: 'result_refused', reason: applied.reason };
      }

      return { effectId };
    }

    const waiting = this.store.findEffect(effectId);

    if (waiting && !waiting.terminal) {
      waiting.status = 'present';
      this.store.saveEffect(waiting);
    }

    const current = this.must(run.id);
    const nextState = waitingState(kind, role);

    if (current.state !== nextState) {
      this.transition(
        current,
        nextState,
        kind === 'agent_follow_up' ? 'repair_follow_up' : 'awaiting_result',
      );
    }

    return { effectId, stop: 'awaiting_result' };
  }

  private async reconcile(effectId: string): Promise<'stay' | 'continue'> {
    // A lost response may still have created the agent or delivered a follow-up.
    // Cursor follow-ups have no idempotency key, so this read happens before any resend.
    const effect = this.store.findEffect(effectId);

    if (!effect) {
      return 'stay';
    }

    let result;

    try {
      result = await Promise.resolve(this.adapter.reconcile(effect.request));
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      this.log.write(`adapter reconcile failed: ${name}`);
      result = { outcome: 'uncertain' as const };
    }

    this.log.write(`reconcile ${effect.id} ${result.outcome}`);

    if (result.outcome === 'uncertain') {
      effect.status = 'unknown';
      effect.outcome = { reconciled: 'uncertain' };
      this.store.saveEffect(effect);
      const run = this.must(effect.runId);

      if (run.state !== 'reconciling') {
        this.transition(run, 'reconciling', 'outcome_unknown');
      }

      return 'stay';
    }

    if (result.outcome === 'absent') {
      effect.status = 'absent';
      effect.terminal = true;
      effect.outcome = { reconciled: 'absent' };
      this.store.saveEffect(effect);
      const run = this.must(effect.runId);
      const back = rollbackState(effect);

      if (run.state !== back) {
        this.transition(run, back, 'reconciled_absent');
      }

      return 'continue';
    }

    effect.status = 'present';
    effect.externalId = result.externalId;
    effect.outcome = { reconciled: 'present' };
    this.store.saveEffect(effect);
    this.countAgent(this.store.findEffect(effectId) ?? effect);

    if (effect.role === 'writer' && effect.kind === 'agent_launch') {
      const run = this.must(effect.runId);
      this.store.saveRun({
        ...run,
        writerExternalId: result.externalId,
        updatedAt: this.now(),
      });
    }

    const run = this.must(effect.runId);
    const waiting = waitingState(effect.kind, effect.role);

    if (run.state !== waiting) {
      this.transition(run, waiting, 'reconciled');
    }

    const queued = this.store.takeInbox(effect.id, effect.clientToken);

    for (const item of queued) {
      this.deliverCompletion(asCompletion(item.payload));
    }

    const done = this.store.findEffect(effectId);

    return done?.terminal ? 'continue' : 'stay';
  }

  private applyArtifact(
    effect: EffectRecord,
    artifact: ArtifactPayload,
  ): ApplyResult {
    const run = this.must(effect.runId);
    this.countAgent(this.store.findEffect(effect.id) ?? effect);

    if (artifact.kind === 'implementation') {
      return this.applyImplementation(effect, artifact, run);
    }

    if (artifact.kind === 'test_evidence') {
      return this.applyTests(effect, artifact, run);
    }

    if (artifact.kind === 'review') {
      return this.applyReview(effect, artifact, run);
    }

    return this.applyMerge(effect, artifact, this.must(effect.runId));
  }

  private applyImplementation(
    effect: EffectRecord,
    artifact: Extract<ArtifactPayload, { kind: 'implementation' }>,
    run: RunRecord,
  ): ApplyResult {
    if (artifact.writerId !== run.config.writerId) {
      this.finishEffect(effect, 'refused', { reason: 'writer_not_allowed' });
      return this.result(run, false, 'refused', 'writer_not_allowed');
    }

    const context = run.contract
      ? this.store.loadContext(
          run.contract.contextId,
          run.contract.contextVersion,
        )
      : undefined;

    if (
      !run.contract ||
      !context ||
      context.invalidatedAt !== null ||
      artifact.contextId !== run.contract.contextId ||
      artifact.contextVersion !== run.contract.contextVersion ||
      artifact.contextHash !== run.contract.contextHash
    ) {
      this.finishEffect(effect, 'refused', { reason: 'stale_context' });
      return this.result(run, false, 'refused', 'stale_context');
    }

    if (run.headSha && run.headSha !== artifact.commitSha) {
      this.store.markArtifactsStale(run.id);
    }

    this.store.insertArtifact({
      id: this.ids(),
      runId: run.id,
      kind: artifact.kind,
      commitSha: artifact.commitSha,
      contextId: artifact.contextId,
      contextVersion: artifact.contextVersion,
      payload: artifact,
      stale: false,
      createdAt: this.now(),
    });
    this.addAttempt(
      run.id,
      artifact.kind,
      effect,
      artifact.commitSha,
      artifact,
    );
    let current = this.must(run.id);
    current = {
      ...current,
      headSha: artifact.commitSha,
    };

    if (
      current.state === 'pinned_contract' ||
      current.state === 'bounded_repair' ||
      current.state === 'reconciling'
    ) {
      current = this.transition(
        current,
        'implementation',
        effect.kind === 'agent_follow_up' ? 'repair_follow_up' : 'agent_launch',
      );
    }

    const next = this.transition(
      current,
      'trusted_tests',
      'implementation_result',
    );
    this.finishEffect(effect, 'applied', artifact);
    return this.result(next, true, 'applied');
  }

  private applyTests(
    effect: EffectRecord,
    artifact: Extract<ArtifactPayload, { kind: 'test_evidence' }>,
    run: RunRecord,
  ): ApplyResult {
    if (!run.headSha || artifact.commitSha !== run.headSha) {
      return this.result(run, false, 'refused', 'stale_sha');
    }

    const failed = artifact.exitCode !== 0 || artifact.failed > 0;
    this.store.insertArtifact({
      id: this.ids(),
      runId: run.id,
      kind: artifact.kind,
      commitSha: artifact.commitSha,
      contextId: run.contract?.contextId ?? null,
      contextVersion: run.contract?.contextVersion ?? null,
      payload: artifact,
      stale: false,
      createdAt: this.now(),
    });
    this.addAttempt(
      run.id,
      artifact.kind,
      effect,
      artifact.commitSha,
      artifact,
    );
    this.finishEffect(effect, 'applied', artifact);

    if (failed) {
      const blocked = this.block(this.must(run.id), 'tests_failed');
      return this.result(blocked, true, 'applied', 'tests_failed');
    }

    const next = this.transition(
      this.must(run.id),
      'independent_review',
      'tests_passed',
    );
    return this.result(next, true, 'applied');
  }

  private applyReview(
    effect: EffectRecord,
    artifact: Extract<ArtifactPayload, { kind: 'review' }>,
    run: RunRecord,
  ): ApplyResult {
    if (
      artifact.reviewerId === run.config.writerId ||
      artifact.reviewerId === artifact.writerId
    ) {
      this.finishEffect(effect, 'refused', { reason: 'writer_cannot_review' });
      return this.result(run, false, 'refused', 'writer_cannot_review');
    }

    if (artifact.reviewerId !== run.config.reviewerId) {
      this.finishEffect(effect, 'refused', { reason: 'reviewer_not_assigned' });
      return this.result(run, false, 'refused', 'reviewer_not_assigned');
    }

    if (!run.headSha || artifact.commitSha !== run.headSha) {
      return this.result(run, false, 'refused', 'stale_sha');
    }

    this.store.insertArtifact({
      id: this.ids(),
      runId: run.id,
      kind: artifact.kind,
      commitSha: artifact.commitSha,
      contextId: run.contract?.contextId ?? null,
      contextVersion: run.contract?.contextVersion ?? null,
      payload: artifact,
      stale: false,
      createdAt: this.now(),
    });
    this.addAttempt(
      run.id,
      artifact.kind,
      effect,
      artifact.commitSha,
      artifact,
    );
    this.finishEffect(effect, 'applied', artifact);
    const current = this.must(run.id);

    if (artifact.verdict === 'reject') {
      if (current.repairAttempts >= current.config.limits.maxRepairAttempts) {
        const failed = this.fail(current, 'repair_cap');
        return this.result(failed, true, 'applied', 'repair_cap');
      }

      const repair = this.transition(
        current,
        'bounded_repair',
        'review_reject',
      );
      return this.result(repair, true, 'applied', 'review_reject');
    }

    const approved = this.transition(
      current,
      'human_merge_approval',
      'review_accept',
    );
    return this.result(approved, true, 'applied');
  }

  private applyMerge(
    effect: EffectRecord,
    artifact: Extract<ArtifactPayload, { kind: 'merge' }>,
    run: RunRecord,
  ): ApplyResult {
    if (run.config.liveEffectsEnabled) {
      this.finishEffect(effect, 'suppressed', {
        reason: 'live_merge_not_wired',
      });
      const blocked = this.block(run, 'live_merge_not_wired');
      return this.result(blocked, false, 'refused', 'live_merge_not_wired');
    }

    const approval = this.freshApproval(run);

    if (!approval) {
      this.finishEffect(effect, 'refused', { reason: 'approval_missing' });
      const blocked = this.block(run, this.approvalProblem(run));
      return this.result(
        blocked,
        false,
        'refused',
        blocked.blockReason ?? 'approval_missing',
      );
    }

    if (
      !run.headSha ||
      artifact.commitSha !== run.headSha ||
      !artifact.verified
    ) {
      this.finishEffect(effect, 'refused', { reason: 'verification_failed' });
      const blocked = this.block(this.must(run.id), 'verification_failed');
      return this.result(blocked, false, 'refused', 'verification_failed');
    }

    const outcome = { ...artifact, simulated: true, live: false };
    this.store.insertArtifact({
      id: this.ids(),
      runId: run.id,
      kind: artifact.kind,
      commitSha: artifact.commitSha,
      contextId: null,
      contextVersion: null,
      payload: outcome,
      stale: false,
      createdAt: this.now(),
    });
    this.finishEffect(effect, 'applied', outcome);
    const verified = this.transition(
      this.must(run.id),
      'verified',
      'simulated_verification',
    );
    return this.result(verified, true, 'applied');
  }

  private pin(run: RunRecord): void {
    const pinned = this.pinContext(run.config.sources);
    const contract = this.buildContract(run, pinned.context, pinned.reused);
    this.transition(
      { ...run, contract, contextId: pinned.context.id, blockReason: null },
      'pinned_contract',
      'pin_contract',
    );
  }

  private pinContext(sources: ContextSource[]): {
    context: TaskContext;
    reused: boolean;
  } {
    const contentHash = hashSources(sources);
    const reusable = this.store.findReusableContext(contentHash);

    if (reusable) {
      return { context: reusable, reused: true };
    }

    const prior = this.store.latestContextByHash(contentHash);
    const context: TaskContext = {
      id: prior?.id ?? this.ids(),
      version: prior ? prior.version + 1 : 1,
      contentHash,
      sources,
      reused: false,
      priorVersion: prior?.version ?? null,
      invalidatedAt: null,
      invalidationReason: null,
    };
    this.store.insertContext(context);
    return { context, reused: false };
  }

  private buildContract(
    run: RunRecord,
    context: TaskContext,
    reused: boolean,
  ): TaskContract {
    return {
      id: this.ids(),
      version: context.version,
      objective: run.config.objective,
      acceptance: run.config.acceptance,
      repository: run.config.repository,
      baseRef: run.config.baseRef,
      baseSha: run.config.baseSha,
      writerId: run.config.writerId,
      reviewerId: run.config.reviewerId,
      ownerId: run.config.ownerId,
      contextId: context.id,
      contextVersion: context.version,
      contextHash: context.contentHash,
      contextReused: reused,
      pinnedAt: new Date(this.now()).toISOString(),
    };
  }

  private freshApproval(run: RunRecord): ApprovalRecord | undefined {
    return this.store
      .listApprovals(run.id)
      .find((approval) => this.approvalFresh(run, approval));
  }

  private approvalFresh(run: RunRecord, approval: ApprovalRecord): boolean {
    return (
      approval.commitSha === run.headSha &&
      approval.approverId === run.config.ownerId &&
      approval.effect === 'guarded_merge' &&
      approval.expiresAt > this.now()
    );
  }

  private approvalProblem(run: RunRecord): string {
    const latest = this.store.listApprovals(run.id).at(-1);

    if (!latest) {
      return 'approval_missing';
    }

    if (latest.expiresAt <= this.now()) {
      return 'approval_expired';
    }

    if (latest.commitSha !== run.headSha) {
      return 'stale_sha';
    }

    return 'approval_missing';
  }

  private tick(run: RunRecord): RunRecord {
    if (!isActiveState(run.state)) {
      return run;
    }

    const now = this.now();
    const elapsed = Math.max(0, now - run.lastTickAt);

    if (elapsed === 0) {
      return run;
    }

    const activeMs = run.activeMs + elapsed;
    const updated = { ...run, activeMs, lastTickAt: now, updatedAt: now };

    if (activeMs >= run.config.limits.maxActiveMinutes * 60_000) {
      return this.fail(updated, 'cap_exhausted');
    }

    this.store.saveRun(updated);
    return updated;
  }

  private transition(
    run: RunRecord,
    to: PipelineState,
    reason: string,
  ): RunRecord {
    const next: RunRecord = {
      ...run,
      state: to,
      version: run.version + 1,
      updatedAt: this.now(),
    };

    if (to !== 'blocked') {
      next.blockReason = null;
    }

    this.store.transaction(() => {
      this.store.saveRun(next);
      this.store.appendVersion({
        runId: next.id,
        version: next.version,
        state: to,
        reason,
        at: next.updatedAt,
      });
      this.store.insertEvent({
        id: `transition:${next.id}:${next.version}`,
        runId: next.id,
        type: 'transition',
        payload: { from: run.state, to, reason },
        status: 'applied',
        result: {
          ok: true,
          status: 'applied',
          state: to,
          version: next.version,
        },
        receivedAt: next.updatedAt,
      });
    });
    this.log.write(`run ${next.id} ${run.state} -> ${to} (${reason})`);
    return next;
  }

  private block(run: RunRecord, reason: string): RunRecord {
    return this.transition({ ...run, blockReason: reason }, 'blocked', reason);
  }

  private fail(run: RunRecord, reason: string): RunRecord {
    return this.transition(
      { ...run, failReason: reason, blockReason: null },
      'failed',
      reason,
    );
  }

  private suppressMerge(run: RunRecord, reason: string): void {
    const now = this.now();
    const effectId = this.ids();
    this.store.transaction(() => {
      this.store.insertEffect({
        id: effectId,
        runId: run.id,
        kind: 'guarded_merge',
        role: 'merge',
        status: 'suppressed',
        clientToken: `token-${effectId}`,
        externalId: null,
        attempt: 1,
        deliveryAttempted: false,
        terminal: true,
        counted: false,
        request: emptyRequest(run, effectId, reason),
        outcome: { reason, simulated: true, live: false },
        createdAt: now,
      });
      this.store.insertOutbox({
        id: this.ids(),
        effectId,
        status: 'suppressed',
        result: { reason },
        createdAt: now,
      });
    });
    this.block(this.must(run.id), reason);
  }

  private countAgent(effect: EffectRecord): void {
    if (
      effect.counted ||
      (effect.kind !== 'agent_launch' && effect.kind !== 'agent_follow_up')
    ) {
      return;
    }

    const run = this.must(effect.runId);
    const current = this.store.findEffect(effect.id) ?? effect;
    current.counted = true;
    this.store.transaction(() => {
      this.store.saveEffect(current);
      this.store.saveRun({
        ...run,
        agentRuns: run.agentRuns + 1,
        updatedAt: this.now(),
      });
    });
  }

  private rememberExternalId(
    effect: EffectRecord,
    result: { outcome: string; externalId?: string },
    role: EffectRole,
  ): void {
    if (!('externalId' in result) || !result.externalId) {
      return;
    }

    const current = this.store.findEffect(effect.id);

    if (!current) {
      return;
    }

    current.externalId = result.externalId;
    this.store.saveEffect(current);

    if (role === 'writer' && effect.kind === 'agent_launch') {
      const run = this.must(effect.runId);
      this.store.saveRun({
        ...run,
        writerExternalId: result.externalId,
        updatedAt: this.now(),
      });
    }

    this.countAgent(this.store.findEffect(effect.id) ?? current);
  }

  private finishEffect(
    effect: EffectRecord,
    status: EffectStatus,
    outcome: unknown,
  ): void {
    const current = this.store.findEffect(effect.id) ?? effect;
    current.status = status;
    current.terminal = true;
    current.outcome = outcome;
    this.store.saveEffect(current);
  }

  private markLatestOutbox(
    effectId: string,
    status: 'pending' | 'delivered' | 'unknown' | 'duplicate' | 'suppressed',
    result: unknown,
  ): void {
    const outbox = this.store.listOutbox(effectId).at(-1);

    if (!outbox) {
      return;
    }

    this.store.saveOutbox({ ...outbox, status, result });
  }

  private addAttempt(
    runId: string,
    kind: string,
    effect: EffectRecord,
    commitSha: string,
    detail: unknown,
  ): void {
    const n =
      this.store.listAttempts(runId).filter((attempt) => attempt.kind === kind)
        .length + 1;
    this.store.insertAttempt({
      runId,
      kind,
      n,
      effectId: effect.id,
      commitSha,
      detail,
    });
  }

  private findCompletionEffect(
    event: CompletionEvent,
  ): EffectRecord | undefined {
    if (event.effectId) {
      return this.store.findEffect(event.effectId);
    }

    if (event.clientToken) {
      return this.store.findEffectByToken(event.clientToken);
    }

    return undefined;
  }

  private rememberEvent(
    id: string,
    runId: string,
    type: string,
    payload: unknown,
    status: string,
    result: ApplyResult,
  ): void {
    if (this.store.findEvent(id)) {
      return;
    }

    this.store.insertEvent({
      id,
      runId,
      type,
      payload,
      status,
      result,
      receivedAt: this.now(),
    });
  }

  private refuse(
    run: RunRecord,
    reason: string,
    type: string,
    eventId = this.ids(),
  ): ApplyResult {
    const result: ApplyResult = {
      ok: false,
      status: 'refused',
      reason,
      state: run.state,
      version: run.version,
    };
    this.rememberEvent(eventId, run.id, type, { reason }, 'refused', result);
    this.log.write(`run ${run.id} refused ${type} ${reason}`);
    return result;
  }

  private result(
    run: RunRecord,
    ok: boolean,
    status: ApplyResult['status'],
    reason?: string,
  ): ApplyResult {
    return {
      ok,
      status,
      ...(reason ? { reason } : {}),
      state: run.state,
      version: run.version,
    };
  }

  private stopped(
    run: RunRecord,
    stopped: StopReason,
    dispatched: string[],
    reason?: string,
  ): PumpResult {
    return {
      ok: stopped !== 'failed' && stopped !== 'step_budget',
      runId: run.id,
      state: run.state,
      version: run.version,
      stopped,
      ...(reason ? { reason } : {}),
      dispatched,
    };
  }

  private must(runId: string): RunRecord {
    const run = this.store.loadRun(runId);

    if (!run) {
      throw new Error(`run ${runId} is missing`);
    }

    return run;
  }

  private now(): number {
    return this.clock.now();
  }
}

function validateCreate(input: CreateRunInput): string | undefined {
  if (input.objective.trim() === '') {
    return 'objective_required';
  }

  if (
    input.acceptance.length === 0 ||
    input.acceptance.some((item) => item.trim() === '')
  ) {
    return 'acceptance_required';
  }

  if (input.repository.trim() === '') {
    return 'repository_required';
  }

  if (!isCommitSha(input.baseSha)) {
    return 'base_sha_invalid';
  }

  if (input.ownerId.trim() === '') {
    return 'owner_required';
  }

  if (input.writerId.trim() === '') {
    return 'writer_required';
  }

  if (input.reviewerId.trim() === '') {
    return 'reviewer_required';
  }

  if (input.reviewerId === input.writerId) {
    return 'reviewer_must_differ';
  }

  if (input.sources.length === 0) {
    return 'sources_required';
  }

  return undefined;
}

function waitingState(
  kind: EffectRecord['kind'],
  role: EffectRole,
): PipelineState {
  if (kind === 'agent_follow_up' || role === 'writer') {
    return 'implementation';
  }

  if (role === 'reviewer') {
    return 'independent_review';
  }

  if (kind === 'trusted_tests') {
    return 'trusted_tests';
  }

  return 'guarded_merge';
}

function rollbackState(effect: EffectRecord): PipelineState {
  if (effect.kind === 'agent_follow_up') {
    return 'bounded_repair';
  }

  if (effect.role === 'reviewer') {
    return 'independent_review';
  }

  if (effect.kind === 'trusted_tests') {
    return 'trusted_tests';
  }

  if (effect.kind === 'guarded_merge') {
    return 'guarded_merge';
  }

  return 'pinned_contract';
}

function latestArtifact<TArtifact extends { kind: string }>(
  artifacts: TArtifact[],
  kind: string,
): TArtifact | undefined {
  return artifacts.filter((artifact) => artifact.kind === kind).at(-1);
}

function reviewPayload(
  artifact:
    | { payload?: unknown; commitSha: string | null; stale: boolean }
    | undefined,
  headSha: string | null,
): Inspection['evidence']['review'] {
  if (!artifact || typeof artifact.commitSha !== 'string') {
    return null;
  }

  const payload = artifact.payload;

  if (
    !payload ||
    typeof payload !== 'object' ||
    !('reviewerId' in payload) ||
    typeof payload.reviewerId !== 'string'
  ) {
    return null;
  }

  return {
    commitSha: artifact.commitSha,
    reviewerId: payload.reviewerId,
    fresh: !artifact.stale && artifact.commitSha === headSha,
  };
}

function asApplyResult(value: unknown): ApplyResult {
  if (
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    'status' in value &&
    typeof value.ok === 'boolean' &&
    typeof value.status === 'string'
  ) {
    return value as ApplyResult;
  }

  return { ok: false, status: 'refused', reason: 'stored_result_invalid' };
}

function asCompletion(value: unknown): CompletionEvent {
  if (
    value &&
    typeof value === 'object' &&
    'id' in value &&
    'artifact' in value &&
    typeof value.id === 'string'
  ) {
    return value as CompletionEvent;
  }

  return { id: 'invalid-inbox', artifact: value };
}

function emptyRequest(
  run: RunRecord,
  effectId: string,
  reason: string,
): EffectRequest {
  return {
    effectId,
    runId: run.id,
    kind: 'guarded_merge',
    role: 'merge',
    clientToken: `token-${effectId}`,
    intendedAt: new Date(run.updatedAt).toISOString(),
    writerId: run.config.writerId,
    reviewerId: run.config.reviewerId,
    ownerId: run.config.ownerId,
    repository: run.config.repository,
    baseSha: run.config.baseSha,
    headSha: run.headSha,
    contextId: run.contract?.contextId ?? '',
    contextVersion: run.contract?.contextVersion ?? 0,
    contextHash: run.contract?.contextHash ?? '',
    objective: run.config.objective,
    acceptance: run.config.acceptance,
    writerExternalId: run.writerExternalId,
    prompt: reason,
    simulated: true,
    live: false,
  };
}
