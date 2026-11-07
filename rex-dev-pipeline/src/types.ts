export const PILOT_LIMITS = {
  maxWriters: 1,
  maxRepairAttempts: 2,
  maxAgentRuns: 7,
  maxActiveMinutes: 90,
} as const;

export type PilotLimits = {
  maxWriters: 1;
  maxRepairAttempts: number;
  maxAgentRuns: number;
  maxActiveMinutes: number;
};

export type PipelineState =
  | 'authorized_intake'
  | 'pinned_contract'
  | 'implementation'
  | 'trusted_tests'
  | 'independent_review'
  | 'bounded_repair'
  | 'human_merge_approval'
  | 'guarded_merge'
  | 'verified'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'reconciling';

export type EffectKind =
  | 'agent_launch'
  | 'agent_follow_up'
  | 'trusted_tests'
  | 'guarded_merge';

export type EffectRole = 'writer' | 'reviewer' | 'test' | 'merge';

export type EffectStatus =
  | 'intended'
  | 'unknown'
  | 'present'
  | 'absent'
  | 'applied'
  | 'suppressed'
  | 'refused';

export type UsageEnvelope = {
  acknowledged: true;
};

export type ContextSource = {
  kind: 'repository_tree' | 'prior_artifact' | 'intake';
  ref: string;
  sha?: string;
  capturedAt: string;
};

export type RunConfig = {
  ownerId: string;
  writerId: string;
  reviewerId: string;
  repository: string;
  baseRef: string;
  baseSha: string;
  objective: string;
  acceptance: string[];
  sources: ContextSource[];
  liveEffectsEnabled: boolean;
  limits: PilotLimits;
  usageEnvelope: UsageEnvelope | null;
  engineeringCapsNotDollarCaps: true;
};

export type TaskContext = {
  id: string;
  version: number;
  contentHash: string;
  sources: ContextSource[];
  reused: boolean;
  priorVersion: number | null;
  invalidatedAt: number | null;
  invalidationReason: string | null;
};

export type TaskContract = {
  id: string;
  version: number;
  objective: string;
  acceptance: string[];
  repository: string;
  baseRef: string;
  baseSha: string;
  writerId: string;
  reviewerId: string;
  ownerId: string;
  contextId: string;
  contextVersion: number;
  contextHash: string;
  contextReused: boolean;
  pinnedAt: string;
};

export type RunRecord = {
  id: string;
  state: PipelineState;
  version: number;
  config: RunConfig;
  contract: TaskContract | null;
  contextId: string | null;
  headSha: string | null;
  writerExternalId: string | null;
  repairAttempts: number;
  agentRuns: number;
  activeMs: number;
  lastTickAt: number;
  pausedFrom: PipelineState | null;
  blockReason: string | null;
  failReason: string | null;
  pausedReason: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EffectRecord = {
  id: string;
  runId: string;
  kind: EffectKind;
  role: EffectRole;
  status: EffectStatus;
  clientToken: string;
  externalId: string | null;
  attempt: number;
  deliveryAttempted: boolean;
  terminal: boolean;
  counted: boolean;
  request: EffectRequest;
  outcome: unknown;
  createdAt: number;
};

export type EffectRequest = {
  effectId: string;
  runId: string;
  kind: EffectKind;
  role: EffectRole;
  clientToken: string;
  intendedAt: string;
  writerId: string;
  reviewerId: string;
  ownerId: string;
  repository: string;
  baseSha: string;
  headSha: string | null;
  contextId: string;
  contextVersion: number;
  contextHash: string;
  objective: string;
  acceptance: string[];
  writerExternalId: string | null;
  prompt: string;
  simulated: boolean;
  live: boolean;
};

export type OutboxRecord = {
  id: string;
  effectId: string;
  status: 'pending' | 'delivered' | 'unknown' | 'duplicate' | 'suppressed';
  result: unknown;
  createdAt: number;
};

export type StateVersionRecord = {
  runId: string;
  version: number;
  state: PipelineState;
  reason: string;
  at: number;
};

export type AttemptRecord = {
  runId: string;
  kind: string;
  n: number;
  effectId: string;
  commitSha: string | null;
  detail: unknown;
};

export type ApprovalRecord = {
  id: string;
  runId: string;
  commitSha: string;
  approverId: string;
  effect: 'guarded_merge';
  approvedAt: number;
  expiresAt: number;
};

export type ArtifactRecord = {
  id: string;
  runId: string;
  kind: string;
  commitSha: string | null;
  contextId: string | null;
  contextVersion: number | null;
  payload: unknown;
  stale: boolean;
  createdAt: number;
};

export type StoredEvent = {
  id: string;
  runId: string;
  type: string;
  payload: unknown;
  status: string;
  result: unknown;
  receivedAt: number;
};

export type CreateRunInput = {
  objective: string;
  acceptance: string[];
  sources: ContextSource[];
  repository: string;
  baseRef: string;
  baseSha: string;
  ownerId: string;
  writerId: string;
  reviewerId: string;
  usageEnvelope: UsageEnvelope | null;
  liveEffectsEnabled?: boolean;
  limits?: Partial<PilotLimits>;
  approvalTtlMs?: number;
};

export type ImplementationArtifact = {
  kind: 'implementation';
  writerId: string;
  commitSha: string;
  summary: string;
  filesChanged: string[];
  contextId: string;
  contextVersion: number;
  contextHash: string;
};

export type TestEvidence = {
  kind: 'test_evidence';
  commitSha: string;
  command: string;
  exitCode: number;
  passed: number;
  failed: number;
  outputDigest: string;
};

export type ReviewArtifact = {
  kind: 'review';
  commitSha: string;
  reviewerId: string;
  writerId: string;
  verdict: 'accept' | 'reject';
  findings: string[];
};

export type MergeArtifact = {
  kind: 'merge';
  commitSha: string;
  verified: boolean;
};

export type ArtifactPayload =
  | ImplementationArtifact
  | TestEvidence
  | ReviewArtifact
  | MergeArtifact;

export type CompletionEvent = {
  id: string;
  effectId?: string;
  clientToken?: string;
  artifact: unknown;
};

export type ApprovalInput = {
  id?: string;
  approverId: string;
  commitSha: string;
  effect: 'guarded_merge';
  expiresAt: number;
};

export type ApplyResult = {
  ok: boolean;
  status: 'applied' | 'duplicate' | 'queued' | 'refused' | 'reconcile_required';
  reason?: string;
  state?: PipelineState;
  version?: number;
};

export type StopReason =
  | 'paused'
  | 'awaiting_approval'
  | 'awaiting_result'
  | 'reconciling'
  | 'blocked'
  | 'failed'
  | 'verified'
  | 'result_refused'
  | 'interrupted'
  | 'step_budget'
  | 'envelope_missing';

export type PumpResult = {
  ok: boolean;
  runId: string;
  state: PipelineState;
  version: number;
  stopped: StopReason;
  reason?: string;
  dispatched: string[];
};

export type LedgerEntry = {
  id: string;
  kind: EffectKind;
  role: EffectRole;
  status: EffectStatus;
  terminal: boolean;
  counted: boolean;
  clientToken: string;
  externalId: string | null;
  attempt: number;
  simulated: boolean;
  live: boolean;
};

export type Inspection = {
  runId: string;
  state: PipelineState;
  version: number;
  headSha: string | null;
  blockReason: string | null;
  failReason: string | null;
  pausedReason: string | null;
  pausedFrom: PipelineState | null;
  resumable: boolean;
  terminal: boolean;
  engineeringCapsNotDollarCaps: true;
  limits: PilotLimits;
  usageEnvelope: UsageEnvelope | null;
  liveEffectsEnabled: boolean;
  agentRuns: number;
  repairAttempts: number;
  activeMinutes: number;
  writerExternalId: string | null;
  contract: TaskContract | null;
  context: TaskContext | null;
  evidence: {
    tests: { commitSha: string; fresh: boolean } | null;
    review: { commitSha: string; reviewerId: string; fresh: boolean } | null;
    approval: { commitSha: string; expiresAt: number; fresh: boolean } | null;
  };
  ledger: LedgerEntry[];
  outbox: OutboxRecord[];
  versions: StateVersionRecord[];
  attempts: AttemptRecord[];
  graph: string;
};

export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_PATTERN.test(value);
}

export function resolveLimits(input?: Partial<PilotLimits>): PilotLimits {
  return {
    maxWriters: 1,
    maxRepairAttempts: clampInteger(
      input?.maxRepairAttempts,
      0,
      PILOT_LIMITS.maxRepairAttempts,
      PILOT_LIMITS.maxRepairAttempts,
    ),
    maxAgentRuns: clampInteger(
      input?.maxAgentRuns,
      1,
      PILOT_LIMITS.maxAgentRuns,
      PILOT_LIMITS.maxAgentRuns,
    ),
    maxActiveMinutes: clampInteger(
      input?.maxActiveMinutes,
      1,
      PILOT_LIMITS.maxActiveMinutes,
      PILOT_LIMITS.maxActiveMinutes,
    ),
  };
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

export function isActiveState(state: PipelineState): boolean {
  return (
    state !== 'paused' &&
    state !== 'blocked' &&
    state !== 'failed' &&
    state !== 'verified' &&
    state !== 'human_merge_approval'
  );
}

export function isTerminalState(state: PipelineState): boolean {
  return state === 'failed' || state === 'verified';
}
