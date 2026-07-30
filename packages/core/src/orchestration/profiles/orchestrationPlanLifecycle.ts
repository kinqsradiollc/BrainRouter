/**
 * P23-3a ephemeral lifecycle for a resolved orchestration-plan preview.
 *
 * The lifecycle stores only bounded stage identity and state. It deliberately
 * never stores tool arguments or dispatch callbacks, so an unstarted stage
 * cannot become a deferred raw orchestration call after its parent turn ends.
 */
import type {
  ResolvedOrchestrationStage,
  ResolvedWorkspaceOrchestrationPlan,
} from './orchestrationProfileResolver.js';

export type OrchestrationStageState =
  | 'planned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type OrchestrationLifecycleTerminationReason =
  | 'turn-ended'
  | 'turn-interrupted'
  | 'session-changed';

export interface OrchestrationLifecycleOwner {
  turnId: string;
  sessionKey: string;
}

export interface OrchestrationStageLifecycleSnapshot {
  id: string;
  state: OrchestrationStageState;
  executorKind: ResolvedOrchestrationStage['executor']['kind'];
  roleId?: string;
  terminalReason?: OrchestrationLifecycleTerminationReason | 'runtime-unavailable';
}

export interface OrchestrationPlanLifecycleDiagnostic {
  code: 'orchestration-runtime-unavailable';
  stageId: string;
  terminal: true;
  retryable: false;
}

export class OrchestrationStageLaunchRejectedError extends Error {
  readonly code =
    'orchestration-stage-launch-rejected';

  constructor(
    readonly reason:
      | 'lifecycle-closed'
      | 'owner-mismatch'
      | 'stage-unavailable'
      | 'stage-not-ready'
      | 'executor-mismatch'
      | 'role-mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'OrchestrationStageLaunchRejectedError';
  }
}

interface MutableStageRecord {
  stage: {
    id: string;
    executor: ResolvedOrchestrationStage['executor'];
    after: readonly string[];
  };
  state: OrchestrationStageState;
  terminalReason?: OrchestrationStageLifecycleSnapshot['terminalReason'];
}

export class EphemeralOrchestrationPlanLifecycle {
  readonly owner: Readonly<OrchestrationLifecycleOwner>;
  private readonly stages = new Map<string, MutableStageRecord>();
  private closed = false;
  private runtimeDiagnostic?: OrchestrationPlanLifecycleDiagnostic;

  constructor(
    owner: Readonly<OrchestrationLifecycleOwner>,
    plan: Pick<ResolvedWorkspaceOrchestrationPlan, 'stages'>,
  ) {
    this.owner = Object.freeze({ ...owner });
    for (const stage of plan.stages) {
      this.stages.set(stage.id, {
        stage: {
          id: stage.id,
          executor: Object.freeze({ ...stage.executor }),
          after: Object.freeze([...stage.after]),
        },
        state: 'planned',
      });
    }
  }

  snapshot(): OrchestrationStageLifecycleSnapshot[] {
    return [...this.stages.values()].map(({ stage, state, terminalReason }) => ({
      id: stage.id,
      state,
      executorKind: stage.executor.kind,
      ...(stage.executor.kind === 'role' ? { roleId: stage.executor.roleId } : {}),
      ...(terminalReason ? { terminalReason } : {}),
    }));
  }

  beginPrimary(stageId: string, owner: Readonly<OrchestrationLifecycleOwner>): void {
    const record = this.assertLaunchable(stageId, owner);
    if (record.stage.executor.kind !== 'primary') {
      throw new OrchestrationStageLaunchRejectedError(
        'executor-mismatch',
        `Stage "${stageId}" requires a delegated role and cannot run on the primary agent.`,
      );
    }
    record.state = 'running';
  }

  beginDelegation(
    stageId: string,
    roleId: string,
    owner: Readonly<OrchestrationLifecycleOwner>,
  ): void {
    const record = this.assertLaunchable(stageId, owner);
    if (record.stage.executor.kind !== 'role') {
      throw new OrchestrationStageLaunchRejectedError(
        'executor-mismatch',
        `Delegation not started: stage "${stageId}" is primary-only.`,
      );
    }
    if (record.stage.executor.roleId !== roleId) {
      throw new OrchestrationStageLaunchRejectedError(
        'role-mismatch',
        `Delegation not started: stage "${stageId}" allows role "${record.stage.executor.roleId}", not "${roleId}".`,
      );
    }
    record.state = 'running';
  }

  finishStage(stageId: string, outcome: 'succeeded' | 'failed' | 'skipped'): void {
    const record = this.requireStage(stageId);
    if (outcome === 'skipped') {
      if (record.state !== 'planned') {
        throw new OrchestrationStageLaunchRejectedError(
          'stage-not-ready',
          `Stage "${stageId}" cannot be skipped from state "${record.state}".`,
        );
      }
    } else if (record.state !== 'running') {
      throw new OrchestrationStageLaunchRejectedError(
        'stage-not-ready',
        `Stage "${stageId}" cannot finish from state "${record.state}".`,
      );
    }
    record.state = outcome;
  }

  /**
   * Record the fail-closed missing-port condition once for the whole plan.
   * Descendants that have not started are cancelled and cannot be replayed.
   */
  recordRuntimeUnavailable(stageId: string): OrchestrationPlanLifecycleDiagnostic | undefined {
    if (this.runtimeDiagnostic) return undefined;
    const record = this.requireStage(stageId);
    if (record.state === 'planned' || record.state === 'running') {
      record.state = 'failed';
      record.terminalReason = 'runtime-unavailable';
    }
    this.cancelUnstartedDescendants(stageId);
    this.runtimeDiagnostic = {
      code: 'orchestration-runtime-unavailable',
      stageId,
      terminal: true,
      retryable: false,
    };
    return this.runtimeDiagnostic;
  }

  /**
   * Close the ephemeral owner. Only unstarted stages are cancelled: work whose
   * launch was already accepted finishes through the existing child-completion
   * contract and is never re-invoked by this lifecycle.
   */
  terminate(reason: OrchestrationLifecycleTerminationReason): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.stages.values()) {
      if (record.state !== 'planned') continue;
      record.state = 'cancelled';
      record.terminalReason = reason;
    }
  }

  private assertLaunchable(
    stageId: string,
    owner: Readonly<OrchestrationLifecycleOwner>,
  ): MutableStageRecord {
    if (owner.turnId !== this.owner.turnId || owner.sessionKey !== this.owner.sessionKey) {
      this.terminate(owner.sessionKey === this.owner.sessionKey ? 'turn-ended' : 'session-changed');
      throw new OrchestrationStageLaunchRejectedError(
        'owner-mismatch',
        'Delegation not started: the orchestration plan no longer belongs to the active turn.',
      );
    }
    if (this.closed) {
      throw new OrchestrationStageLaunchRejectedError(
        'lifecycle-closed',
        'Delegation not started: the orchestration plan lifecycle has ended.',
      );
    }
    const record = this.requireStage(stageId);
    if (record.state !== 'planned') {
      throw new OrchestrationStageLaunchRejectedError(
        'stage-not-ready',
        `Delegation not started: stage "${stageId}" is already "${record.state}".`,
      );
    }
    for (const dependencyId of record.stage.after) {
      const dependency = this.requireStage(dependencyId);
      if (dependency.state !== 'succeeded' && dependency.state !== 'skipped') {
        throw new OrchestrationStageLaunchRejectedError(
          'stage-not-ready',
          `Delegation not started: stage "${stageId}" is waiting for "${dependencyId}".`,
        );
      }
    }
    return record;
  }

  private requireStage(stageId: string): MutableStageRecord {
    const record = this.stages.get(stageId);
    if (!record) {
      throw new OrchestrationStageLaunchRejectedError(
        'stage-unavailable',
        `Delegation not started: stage "${stageId}" is not in the compiled strategy.`,
      );
    }
    return record;
  }

  private cancelUnstartedDescendants(stageId: string): void {
    const related = new Set([stageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of this.stages.values()) {
        if (related.has(record.stage.id)) continue;
        if (!record.stage.after.some((dependencyId) => related.has(dependencyId))) continue;
        related.add(record.stage.id);
        changed = true;
      }
    }
    for (const relatedId of related) {
      if (relatedId === stageId) continue;
      const record = this.stages.get(relatedId);
      if (!record || record.state !== 'planned') continue;
      record.state = 'cancelled';
      record.terminalReason = 'runtime-unavailable';
    }
  }
}
