import type { PipelineState } from './types';

export type PipelineEdge = {
  from: PipelineState;
  to: PipelineState;
  on: string;
  decidedBy: 'code';
};

export type PipelineNode = {
  state: PipelineState;
  reasoning: 'code' | 'model';
};

export const PIPELINE_NODES: readonly PipelineNode[] = [
  { state: 'authorized_intake', reasoning: 'code' },
  { state: 'pinned_contract', reasoning: 'code' },
  { state: 'implementation', reasoning: 'model' },
  { state: 'trusted_tests', reasoning: 'code' },
  { state: 'independent_review', reasoning: 'model' },
  { state: 'bounded_repair', reasoning: 'model' },
  { state: 'human_merge_approval', reasoning: 'code' },
  { state: 'guarded_merge', reasoning: 'code' },
  { state: 'verified', reasoning: 'code' },
  { state: 'paused', reasoning: 'code' },
  { state: 'blocked', reasoning: 'code' },
  { state: 'failed', reasoning: 'code' },
  { state: 'reconciling', reasoning: 'code' },
];

export const PIPELINE_EDGES: readonly PipelineEdge[] = [
  {
    from: 'authorized_intake',
    to: 'pinned_contract',
    on: 'pin_contract',
    decidedBy: 'code',
  },
  {
    from: 'pinned_contract',
    to: 'implementation',
    on: 'agent_launch',
    decidedBy: 'code',
  },
  {
    from: 'pinned_contract',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'implementation',
    to: 'trusted_tests',
    on: 'implementation_result',
    decidedBy: 'code',
  },
  {
    from: 'implementation',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'trusted_tests',
    to: 'independent_review',
    on: 'tests_passed',
    decidedBy: 'code',
  },
  {
    from: 'trusted_tests',
    to: 'blocked',
    on: 'tests_failed',
    decidedBy: 'code',
  },
  {
    from: 'trusted_tests',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'independent_review',
    to: 'human_merge_approval',
    on: 'review_accept',
    decidedBy: 'code',
  },
  {
    from: 'independent_review',
    to: 'bounded_repair',
    on: 'review_reject',
    decidedBy: 'code',
  },
  {
    from: 'independent_review',
    to: 'failed',
    on: 'repair_cap',
    decidedBy: 'code',
  },
  {
    from: 'independent_review',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'bounded_repair',
    to: 'implementation',
    on: 'repair_follow_up',
    decidedBy: 'code',
  },
  {
    from: 'bounded_repair',
    to: 'failed',
    on: 'repair_cap',
    decidedBy: 'code',
  },
  {
    from: 'bounded_repair',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'human_merge_approval',
    to: 'guarded_merge',
    on: 'owner_approval',
    decidedBy: 'code',
  },
  {
    from: 'human_merge_approval',
    to: 'blocked',
    on: 'approval_missing',
    decidedBy: 'code',
  },
  {
    from: 'human_merge_approval',
    to: 'trusted_tests',
    on: 'commit_advanced',
    decidedBy: 'code',
  },
  {
    from: 'guarded_merge',
    to: 'verified',
    on: 'simulated_verification',
    decidedBy: 'code',
  },
  {
    from: 'guarded_merge',
    to: 'blocked',
    on: 'live_merge_not_wired',
    decidedBy: 'code',
  },
  {
    from: 'guarded_merge',
    to: 'blocked',
    on: 'approval_expired',
    decidedBy: 'code',
  },
  {
    from: 'guarded_merge',
    to: 'reconciling',
    on: 'outcome_unknown',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'implementation',
    on: 'reconciled',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'trusted_tests',
    on: 'reconciled',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'independent_review',
    on: 'reconciled',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'bounded_repair',
    on: 'reconciled',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'pinned_contract',
    on: 'reconciled_absent',
    decidedBy: 'code',
  },
  {
    from: 'reconciling',
    to: 'guarded_merge',
    on: 'reconciled',
    decidedBy: 'code',
  },
  {
    from: 'blocked',
    to: 'guarded_merge',
    on: 'owner_approval',
    decidedBy: 'code',
  },
  {
    from: 'blocked',
    to: 'pinned_contract',
    on: 'repin_context',
    decidedBy: 'code',
  },
];

const RESUME_TARGETS = new Set<PipelineState>([
  'authorized_intake',
  'pinned_contract',
  'implementation',
  'trusted_tests',
  'independent_review',
  'bounded_repair',
  'human_merge_approval',
  'guarded_merge',
  'reconciling',
  'blocked',
]);

export function isDocumentedTransition(
  from: PipelineState,
  to: PipelineState,
): boolean {
  if (from === to) {
    return true;
  }

  if (to === 'paused' || to === 'failed') {
    return true;
  }

  // Block is an overlay because invalidation, test failure, and approval
  // problems enter it from more than one state. Verified, failed, and paused
  // do not.
  if (
    to === 'blocked' &&
    from !== 'verified' &&
    from !== 'failed' &&
    from !== 'paused'
  ) {
    return true;
  }

  if (from === 'paused' && RESUME_TARGETS.has(to)) {
    return true;
  }

  return PIPELINE_EDGES.some((edge) => edge.from === from && edge.to === to);
}

export function formatGraph(current?: PipelineState): string {
  const lines = ['digraph dev_pipeline {'];

  for (const node of PIPELINE_NODES) {
    const currentMarker = node.state === current ? ' (current)' : '';
    lines.push(
      `  ${node.state} [label="${node.state}${currentMarker}\\n${node.reasoning}"];`,
    );
  }

  for (const edge of PIPELINE_EDGES) {
    lines.push(`  ${edge.from} -> ${edge.to} [label="${edge.on}"];`);
  }

  lines.push(
    '  // paused, failed, blocked, and resume edges are code-owned overlays',
  );
  lines.push('}');

  return lines.join('\n');
}

export function formatGraphText(current?: PipelineState): string {
  const lines = ['state machine (routine edges are code, not a model choice)'];

  for (const edge of PIPELINE_EDGES) {
    const marker = edge.from === current ? '  <= current' : '';
    lines.push(`  ${edge.from} -> ${edge.to}  [${edge.on}]${marker}`);
  }

  if (current) {
    lines.push(`current: ${current}`);
  }

  return lines.join('\n');
}
