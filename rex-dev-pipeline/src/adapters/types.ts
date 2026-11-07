import type { ApplyResult, CompletionEvent, EffectRequest } from '../types';

export type DispatchResult =
  | { outcome: 'accepted'; externalId: string; artifact?: unknown }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'conflict_exists'; externalId: string };

export type ReconcileResult =
  | { outcome: 'present'; externalId: string }
  | { outcome: 'absent' }
  | { outcome: 'uncertain' };

export type EffectSink = {
  deliverCompletion: (event: CompletionEvent) => ApplyResult;
};

export type PipelineAdapter = {
  dispatch: (
    request: EffectRequest,
    sink: EffectSink,
  ) => DispatchResult | Promise<DispatchResult>;
  reconcile: (
    request: EffectRequest,
  ) => ReconcileResult | Promise<ReconcileResult>;
};
