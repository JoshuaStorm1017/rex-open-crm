import type { EffectKind, EffectRequest, EffectRole } from '../types';
import type {
  DispatchResult,
  EffectSink,
  PipelineAdapter,
  ReconcileResult,
} from './types';

export type ScriptedPlan = {
  kind: EffectKind;
  role?: EffectRole;
  outcome: 'accepted' | 'unknown' | 'refused';
  record?: boolean;
  externalId?: string;
  artifact?: unknown | ((request: EffectRequest) => unknown);
  reason?: string;
  reconcile?: ReconcileResult['outcome'];
  beforeReturn?: (request: EffectRequest, sink: EffectSink) => void;
};

type UsedPlan = ScriptedPlan & { used?: boolean };

export class ScriptedAdapter implements PipelineAdapter {
  readonly calls: EffectRequest[] = [];
  readonly reconcileCalls: EffectRequest[] = [];
  readonly trace: Array<'dispatch' | 'reconcile'> = [];
  private readonly plans: UsedPlan[];
  private readonly landed = new Map<string, string>();
  private readonly hints = new Map<string, ReconcileResult['outcome']>();

  constructor(plans: ScriptedPlan[]) {
    this.plans = plans.map((plan) => ({ ...plan }));
  }

  dispatch(request: EffectRequest, sink: EffectSink): DispatchResult {
    this.calls.push(request);
    this.trace.push('dispatch');
    const plan = this.plans.find(
      (candidate) =>
        !candidate.used &&
        candidate.kind === request.kind &&
        (candidate.role === undefined || candidate.role === request.role),
    );

    if (!plan) {
      return { outcome: 'refused', reason: 'no_scripted_result' };
    }

    plan.used = true;
    plan.beforeReturn?.(request, sink);
    const externalId = plan.externalId ?? `sim-${request.clientToken}`;
    this.hints.set(request.clientToken, plan.reconcile ?? 'present');

    if (plan.outcome === 'refused') {
      return { outcome: 'refused', reason: plan.reason ?? 'refused' };
    }

    const shouldRecord = plan.record ?? plan.outcome === 'accepted';

    if (shouldRecord) {
      this.landed.set(request.clientToken, externalId);
    }

    if (plan.outcome === 'unknown') {
      return { outcome: 'unknown' };
    }

    const artifact =
      typeof plan.artifact === 'function'
        ? plan.artifact(request)
        : plan.artifact;

    return {
      outcome: 'accepted',
      externalId,
      ...(artifact !== undefined ? { artifact } : {}),
    };
  }

  reconcile(request: EffectRequest): ReconcileResult {
    this.reconcileCalls.push(request);
    this.trace.push('reconcile');
    const hint = this.hints.get(request.clientToken);

    if (hint === 'uncertain') {
      return { outcome: 'uncertain' };
    }

    if (hint === 'absent') {
      return { outcome: 'absent' };
    }

    const externalId = this.landed.get(request.clientToken);

    if (!externalId) {
      return { outcome: 'absent' };
    }

    return { outcome: 'present', externalId };
  }
}
