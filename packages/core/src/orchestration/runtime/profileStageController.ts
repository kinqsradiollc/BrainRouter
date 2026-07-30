/**
 * Turn-owned controller for primary and delegated orchestration-profile stages.
 *
 * The controller is deliberately narrower than the orchestration plan:
 * delegated stages still launch through the child-agent chokepoint. This owner
 * activates one declared primary-stage skill at a time, advances dependencies,
 * and clears tool policy before the turn can move to another stage.
 */
import {
  EphemeralOrchestrationPlanLifecycle,
  OrchestrationStageLaunchRejectedError,
  type OrchestrationLifecycleOwner,
  type OrchestrationLifecycleTerminationReason,
  type OrchestrationStageLifecycleSnapshot,
} from '../profiles/orchestrationPlanLifecycle.js';
import type {
  ResolvedOrchestrationStage,
  ResolvedWorkspaceOrchestrationPlan,
} from '../profiles/orchestrationProfileResolver.js';
import { validateChildOutputSections } from '../roles/outputContracts.js';
import type { StageSkillActivation } from './stageSkillActivation.js';

export type PrimaryStageSkillActivation = StageSkillActivation;

export interface ProfileStageControllerHooks {
  loadSkill(skillId: string): Promise<PrimaryStageSkillActivation>;
  setActiveSkill(skill: PrimaryStageSkillActivation | undefined): void;
  onStateChange?(event: ProfileStageStateEvent): void;
}

export interface ProfileStageStateEvent {
  phase: 'resolved' | 'updated' | 'terminated';
  profileId: string;
  strategyId: string;
  selectionSource: ResolvedWorkspaceOrchestrationPlan['selectionSource'];
  stages: Array<{
    id: string;
    state: OrchestrationStageLifecycleSnapshot['state'];
    executor: 'primary' | 'role';
    roleId?: string;
    skillIds: string[];
    activeSkillId?: string;
  }>;
}

export interface RequiredPrimaryStageAction {
  action: 'begin' | 'complete';
  stageId: string;
  skillId: string;
  optional: boolean;
}

export interface RequiredDelegatedStageAction {
  action: 'delegate';
  stageId: string;
  roleId: string;
  optional: boolean;
}

export interface PreparedProfileStageDelegation {
  readonly launchId: string;
  readonly profileId: string;
  readonly strategyId: string;
  readonly stage: ResolvedOrchestrationStage;
  readonly roleId: string;
  readonly assignment?: string;
  readonly skills: readonly PrimaryStageSkillActivation[];
}

export interface ProfileStageDelegationOutput {
  accepted: boolean;
  missingSections: string[];
}

export type PrimaryStageAction =
  | { action: 'begin'; stageId: string; skillId?: string }
  | { action: 'complete'; stageId: string; skillId?: string }
  | { action: 'skip'; stageId: string };

export class PrimaryStageActionRejectedError extends Error {
  readonly code = 'orchestration-primary-stage-action-rejected';

  constructor(
    readonly reason:
      | 'invalid-action'
      | 'stage-unavailable'
      | 'executor-mismatch'
      | 'stage-not-ready'
      | 'stage-required'
      | 'skill-unavailable'
      | 'skill-unexpected'
      | 'skill-not-active',
    message: string,
  ) {
    super(message);
    this.name = 'PrimaryStageActionRejectedError';
  }
}

interface PrimaryStageRecord {
  stage: ResolvedOrchestrationStage;
  completedSkillIds: Set<string>;
}

interface DelegatedStageRecord {
  stage: ResolvedOrchestrationStage;
  pendingLaunchIds: Set<string>;
  completedLaunchIds: Set<string>;
  successfulLaunches: number;
  failedLaunches: number;
}

export class ProfileStageController {
  private readonly lifecycle: EphemeralOrchestrationPlanLifecycle;
  private readonly primaryStages = new Map<string, PrimaryStageRecord>();
  private readonly delegatedStages = new Map<string, DelegatedStageRecord>();
  private readonly preparedDelegations = new Map<string, PreparedProfileStageDelegation>();
  private delegationSequence = 0;
  private activeStageId?: string;
  private activeSkillId?: string;

  constructor(
    readonly owner: Readonly<OrchestrationLifecycleOwner>,
    readonly plan: Pick<
      ResolvedWorkspaceOrchestrationPlan,
      'orchestrationProfileId' | 'strategyId' | 'selectionSource' | 'stages'
    >,
    private readonly hooks: ProfileStageControllerHooks,
  ) {
    this.lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, plan);
    for (const stage of plan.stages) {
      const copied = copyStage(stage);
      if (stage.executor.kind === 'primary') {
        this.primaryStages.set(stage.id, {
          stage: copied,
          completedSkillIds: new Set(),
        });
      } else {
        this.delegatedStages.set(stage.id, {
          stage: copied,
          pendingLaunchIds: new Set(),
          completedLaunchIds: new Set(),
          successfulLaunches: 0,
          failedLaunches: 0,
        });
      }
    }
  }

  async invoke(input: Record<string, unknown>): Promise<string> {
    const action = parseAction(input);
    if (action.action === 'begin') return await this.begin(action.stageId, action.skillId);
    if (action.action === 'complete') return this.complete(action.stageId, action.skillId);
    return this.skip(action.stageId);
  }

  snapshot(): OrchestrationStageLifecycleSnapshot[] {
    return this.lifecycle.snapshot();
  }

  publishResolvedState(): void {
    this.publishState('resolved');
  }

  /**
   * Return the next ready skill transition that must happen before the model
   * may finish. Downstream primary stages remain dormant while an earlier role
   * stage is unresolved; the delegated-stage slice owns that hand-off.
   */
  nextRequiredAction(): RequiredPrimaryStageAction | undefined {
    const states = new Map(this.lifecycle.snapshot().map((stage) => [stage.id, stage.state]));
    if (this.activeStageId && this.activeSkillId) {
      const record = this.primaryStages.get(this.activeStageId);
      if (record) {
        return {
          action: 'complete',
          stageId: this.activeStageId,
          skillId: this.activeSkillId,
          optional: record.stage.optional,
        };
      }
    }
    if (this.activeStageId) {
      const record = this.primaryStages.get(this.activeStageId);
      const skillId = record?.stage.skillIds.find((id) => !record.completedSkillIds.has(id));
      if (record && skillId) {
        return {
          action: 'begin',
          stageId: record.stage.id,
          skillId,
          optional: record.stage.optional,
        };
      }
    }
    for (const record of this.primaryStages.values()) {
      if (record.stage.skillIds.length === 0 || states.get(record.stage.id) !== 'planned') continue;
      const ready = record.stage.after.every((dependencyId) => {
        const state = states.get(dependencyId);
        return state === 'succeeded' || state === 'skipped';
      });
      if (!ready) continue;
      const skillId = record.stage.skillIds.find((id) => !record.completedSkillIds.has(id));
      if (!skillId) continue;
      return {
        action: 'begin',
        stageId: record.stage.id,
        skillId,
        optional: record.stage.optional,
      };
    }
    return undefined;
  }

  nextRequiredDelegation(): RequiredDelegatedStageAction | undefined {
    const states = new Map(this.lifecycle.snapshot().map((stage) => [stage.id, stage.state]));
    for (const record of this.delegatedStages.values()) {
      if (record.stage.optional) continue;
      const state = states.get(record.stage.id);
      const launchCount = record.pendingLaunchIds.size + record.completedLaunchIds.size;
      const needsAnotherLaunch =
        state === 'planned'
        || (
          state === 'running'
          && record.pendingLaunchIds.size === 0
          && record.successfulLaunches < (record.stage.fanOut?.min ?? 1)
          && launchCount < (record.stage.fanOut?.max ?? 1)
        );
      if (!needsAnotherLaunch) continue;
      const ready = record.stage.after.every((dependencyId) => {
        const dependencyState = states.get(dependencyId);
        return dependencyState === 'succeeded' || dependencyState === 'skipped';
      });
      if (!ready) continue;
      return {
        action: 'delegate',
        stageId: record.stage.id,
        roleId: record.stage.executor.kind === 'role'
          ? record.stage.executor.roleId
          : '',
        optional: false,
      };
    }
    return undefined;
  }

  failedRequiredStage(): { stageId: string; roleId?: string } | undefined {
    const states = new Map(this.lifecycle.snapshot().map((stage) => [stage.id, stage.state]));
    for (const stage of this.plan.stages) {
      if (stage.optional || states.get(stage.id) !== 'failed') continue;
      return {
        stageId: stage.id,
        ...(stage.executor.kind === 'role' ? { roleId: stage.executor.roleId } : {}),
      };
    }
    return undefined;
  }

  async prepareDelegation(input: {
    stageId: string;
    requestedRoleId?: string;
    assignment?: string;
  }): Promise<PreparedProfileStageDelegation> {
    const record = this.requireDelegatedStage(input.stageId);
    const roleId = record.stage.executor.kind === 'role'
      ? record.stage.executor.roleId
      : '';
    if (input.requestedRoleId && input.requestedRoleId !== roleId) {
      throw new PrimaryStageActionRejectedError(
        'executor-mismatch',
        `Stage "${input.stageId}" requires delegated role "${roleId}", not "${input.requestedRoleId}".`,
      );
    }
    // Validate caller-supplied scope before mutating the turn-owned lifecycle.
    // A malformed assignment must not leave the stage running with an
    // unowned pending launch that can never settle.
    const assignment = boundedAssignment(input.assignment);

    const state = this.stageState(input.stageId);
    if (state === 'planned') {
      this.lifecycle.beginDelegation(input.stageId, roleId, this.owner);
    } else if (state !== 'running') {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Delegated stage "${input.stageId}" cannot launch from state "${state}".`,
      );
    }

    const max = record.stage.fanOut?.max ?? 1;
    const launchCount = record.pendingLaunchIds.size + record.completedLaunchIds.size;
    if (launchCount >= max) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Delegated stage "${input.stageId}" reached its fan-out ceiling (${max}).`,
      );
    }

    const launchId = `${this.owner.turnId}:${input.stageId}:${++this.delegationSequence}`;
    record.pendingLaunchIds.add(launchId);
    this.publishState('updated');
    let skills: PrimaryStageSkillActivation[];
    try {
      skills = await Promise.all(record.stage.skillIds.map(async (skillId) => {
        const activation = await this.hooks.loadSkill(skillId);
        if (activation.id !== skillId || !activation.instructions.trim()) {
          throw new Error(`skill "${skillId}" returned an invalid activation contract`);
        }
        return {
          ...activation,
          ...(activation.allowedTools
            ? { allowedTools: [...activation.allowedTools] }
            : {}),
          disallowedTools: [...activation.disallowedTools],
        };
      }));
    } catch (error) {
      this.settleDelegation(record, launchId, false);
      const detail = error instanceof Error ? error.message : String(error);
      throw new PrimaryStageActionRejectedError(
        'skill-unavailable',
        `Delegated stage "${input.stageId}" failed closed because its skills could not be loaded: ${detail}`,
      );
    }

    const profileId = this.plan.orchestrationProfileId;
    const strategyId = this.plan.strategyId;
    if (!profileId || !strategyId) {
      this.settleDelegation(record, launchId, false);
      throw new PrimaryStageActionRejectedError(
        'stage-unavailable',
        'The active profile plan no longer has a stable profile and strategy id.',
      );
    }
    const prepared: PreparedProfileStageDelegation = Object.freeze({
      launchId,
      profileId,
      strategyId,
      stage: copyStage(record.stage),
      roleId,
      ...(assignment ? { assignment } : {}),
      skills: Object.freeze(skills),
    });
    this.preparedDelegations.set(launchId, prepared);
    this.publishState('updated');
    return prepared;
  }

  ownsPreparedDelegation(value: unknown): value is PreparedProfileStageDelegation {
    if (!value || typeof value !== 'object') return false;
    const launchId = (value as { launchId?: unknown }).launchId;
    return typeof launchId === 'string'
      && this.preparedDelegations.get(launchId) === value;
  }

  inspectDelegationOutput(
    launch: PreparedProfileStageDelegation,
    output: string,
  ): ProfileStageDelegationOutput {
    const expected = launch.stage.expectedOutput;
    if (!expected) {
      return { accepted: false, missingSections: ['validated-output-contract'] };
    }
    const validation = validateChildOutputSections(
      launch.roleId,
      output,
      expected.requiredSections,
    );
    return {
      accepted: validation.accepted,
      missingSections: validation.missingSections,
    };
  }

  finishDelegation(
    launch: PreparedProfileStageDelegation,
    accepted: boolean,
  ): void {
    this.requirePreparedDelegation(launch);
    const record = this.requireDelegatedStage(launch.stage.id);
    this.preparedDelegations.delete(launch.launchId);
    this.settleDelegation(record, launch.launchId, accepted);
  }

  rejectDelegation(launch: PreparedProfileStageDelegation): void {
    if (!this.ownsPreparedDelegation(launch)) return;
    this.finishDelegation(launch, false);
  }

  terminate(reason: OrchestrationLifecycleTerminationReason): void {
    this.clearActiveSkill();
    this.preparedDelegations.clear();
    this.lifecycle.terminate(reason);
    this.publishState('terminated');
  }

  private async begin(stageId: string, requestedSkillId?: string): Promise<string> {
    const record = this.requirePrimaryStage(stageId);
    if (this.activeSkillId) {
      throw new PrimaryStageActionRejectedError(
        'skill-not-active',
        `Stage "${this.activeStageId}" still has active skill "${this.activeSkillId}". Complete it before beginning another skill.`,
      );
    }
    if (this.activeStageId && this.activeStageId !== stageId) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${this.activeStageId}" is still running. Complete it before beginning "${stageId}".`,
      );
    }

    const stageState = this.stageState(stageId);
    if (stageState === 'planned') {
      this.lifecycle.beginPrimary(stageId, this.owner);
      this.activeStageId = stageId;
    } else if (stageState !== 'running' || this.activeStageId !== stageId) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${stageId}" cannot begin from state "${stageState}".`,
      );
    }

    if (record.stage.skillIds.length === 0) {
      if (requestedSkillId) {
        this.failRunningStage(stageId);
        throw new PrimaryStageActionRejectedError(
          'skill-unexpected',
          `Stage "${stageId}" declares no skills; do not provide skillId.`,
        );
      }
      this.publishState('updated');
      return this.result({
        action: 'began',
        stage: record.stage,
        remainingSkillIds: [],
      });
    }

    const skillId = requestedSkillId
      ?? record.stage.skillIds.find((id) => !record.completedSkillIds.has(id));
    if (!skillId || !record.stage.skillIds.includes(skillId)) {
      this.failRunningStage(stageId);
      throw new PrimaryStageActionRejectedError(
        'skill-unexpected',
        `Skill "${skillId ?? ''}" is not declared by primary stage "${stageId}".`,
      );
    }
    if (record.completedSkillIds.has(skillId)) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Skill "${skillId}" already completed for stage "${stageId}".`,
      );
    }

    let skill: PrimaryStageSkillActivation;
    try {
      skill = await this.hooks.loadSkill(skillId);
    } catch (error) {
      this.failRunningStage(stageId);
      const detail = error instanceof Error ? error.message : String(error);
      throw new PrimaryStageActionRejectedError(
        'skill-unavailable',
        `Stage "${stageId}" failed closed because skill "${skillId}" could not be loaded: ${detail}`,
      );
    }
    if (skill.id !== skillId || !skill.instructions.trim()) {
      this.failRunningStage(stageId);
      throw new PrimaryStageActionRejectedError(
        'skill-unavailable',
        `Stage "${stageId}" failed closed because skill "${skillId}" returned an invalid activation contract.`,
      );
    }

    this.activeSkillId = skillId;
    this.hooks.setActiveSkill(skill);
    this.publishState('updated');
    return this.result({
      action: 'began-skill',
      stage: record.stage,
      activeSkill: skill,
      remainingSkillIds: record.stage.skillIds.filter((id) => (
        id !== skillId && !record.completedSkillIds.has(id)
      )),
    });
  }

  private complete(stageId: string, requestedSkillId?: string): string {
    const record = this.requirePrimaryStage(stageId);
    if (this.activeStageId !== stageId || this.stageState(stageId) !== 'running') {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${stageId}" is not the active running primary stage.`,
      );
    }

    if (record.stage.skillIds.length > 0) {
      if (!this.activeSkillId) {
        throw new PrimaryStageActionRejectedError(
          'skill-not-active',
          `Stage "${stageId}" has no active skill to complete.`,
        );
      }
      if (requestedSkillId && requestedSkillId !== this.activeSkillId) {
        throw new PrimaryStageActionRejectedError(
          'skill-not-active',
          `Stage "${stageId}" has active skill "${this.activeSkillId}", not "${requestedSkillId}".`,
        );
      }
      record.completedSkillIds.add(this.activeSkillId);
      this.clearActiveSkill();
    } else if (requestedSkillId) {
      throw new PrimaryStageActionRejectedError(
        'skill-unexpected',
        `Stage "${stageId}" declares no skills; do not provide skillId.`,
      );
    }

    const remainingSkillIds = record.stage.skillIds.filter((id) => !record.completedSkillIds.has(id));
    if (remainingSkillIds.length === 0) {
      this.lifecycle.finishStage(stageId, 'succeeded');
      this.activeStageId = undefined;
    }
    this.publishState('updated');
    return this.result({
      action: remainingSkillIds.length === 0 ? 'completed-stage' : 'completed-skill',
      stage: record.stage,
      remainingSkillIds,
    });
  }

  private skip(stageId: string): string {
    const stage = this.requireAnyStage(stageId);
    if (!stage.optional) {
      throw new PrimaryStageActionRejectedError(
        'stage-required',
        `Stage "${stageId}" is required and cannot be skipped.`,
      );
    }
    if (this.activeStageId) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${this.activeStageId}" is running; finish it before skipping another stage.`,
      );
    }
    const states = new Map(this.lifecycle.snapshot().map((stage) => [stage.id, stage.state]));
    if (states.get(stageId) !== 'planned') {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${stageId}" cannot be skipped from state "${states.get(stageId)}".`,
      );
    }
    const blockedBy = stage.after.find((dependencyId) => {
      const state = states.get(dependencyId);
      return state !== 'succeeded' && state !== 'skipped';
    });
    if (blockedBy) {
      throw new PrimaryStageActionRejectedError(
        'stage-not-ready',
        `Stage "${stageId}" cannot be skipped before dependency "${blockedBy}" finishes.`,
      );
    }
    this.lifecycle.finishStage(stageId, 'skipped');
    this.publishState('updated');
    return this.result({
      action: 'skipped-stage',
      stage,
      remainingSkillIds: [],
    });
  }

  private requirePrimaryStage(stageId: string): PrimaryStageRecord {
    const record = this.primaryStages.get(stageId);
    if (record) return record;
    const stage = this.lifecycle.snapshot().find((candidate) => candidate.id === stageId);
    throw new PrimaryStageActionRejectedError(
      stage ? 'executor-mismatch' : 'stage-unavailable',
      stage
        ? `Stage "${stageId}" requires delegated role "${stage.roleId ?? 'unknown'}"; profile_stage controls primary stages only.`
        : `Stage "${stageId}" is not in the active orchestration strategy.`,
    );
  }

  private requireDelegatedStage(stageId: string): DelegatedStageRecord {
    const record = this.delegatedStages.get(stageId);
    if (record) return record;
    const stage = this.lifecycle.snapshot().find((candidate) => candidate.id === stageId);
    throw new PrimaryStageActionRejectedError(
      stage ? 'executor-mismatch' : 'stage-unavailable',
      stage
        ? `Stage "${stageId}" runs on the primary agent and cannot launch a delegated child.`
        : `Stage "${stageId}" is not in the active orchestration strategy.`,
    );
  }

  private requireAnyStage(stageId: string): ResolvedOrchestrationStage {
    const primary = this.primaryStages.get(stageId)?.stage;
    if (primary) return primary;
    const delegated = this.delegatedStages.get(stageId)?.stage;
    if (delegated) return delegated;
    throw new PrimaryStageActionRejectedError(
      'stage-unavailable',
      `Stage "${stageId}" is not in the active orchestration strategy.`,
    );
  }

  private requirePreparedDelegation(
    launch: PreparedProfileStageDelegation,
  ): PreparedProfileStageDelegation {
    if (this.ownsPreparedDelegation(launch)) return launch;
    throw new PrimaryStageActionRejectedError(
      'stage-unavailable',
      'The delegated stage launch is not owned by this active turn.',
    );
  }

  private stageState(stageId: string): OrchestrationStageLifecycleSnapshot['state'] {
    const stage = this.lifecycle.snapshot().find((candidate) => candidate.id === stageId);
    if (!stage) {
      throw new PrimaryStageActionRejectedError(
        'stage-unavailable',
        `Stage "${stageId}" is not in the active orchestration strategy.`,
      );
    }
    return stage.state;
  }

  private failRunningStage(stageId: string): void {
    this.clearActiveSkill();
    if (this.stageState(stageId) === 'running') this.lifecycle.finishStage(stageId, 'failed');
    this.activeStageId = undefined;
    this.publishState('updated');
  }

  private clearActiveSkill(): void {
    this.activeSkillId = undefined;
    this.hooks.setActiveSkill(undefined);
  }

  private settleDelegation(
    record: DelegatedStageRecord,
    launchId: string,
    accepted: boolean,
  ): void {
    if (!record.pendingLaunchIds.delete(launchId)) return;
    record.completedLaunchIds.add(launchId);
    if (accepted) record.successfulLaunches += 1;
    else record.failedLaunches += 1;
    if (record.pendingLaunchIds.size > 0) {
      this.publishState('updated');
      return;
    }

    const min = record.stage.fanOut?.min ?? 1;
    const max = record.stage.fanOut?.max ?? 1;
    if (record.successfulLaunches >= min) {
      this.lifecycle.finishStage(record.stage.id, 'succeeded');
      this.publishState('updated');
      return;
    }
    if (record.completedLaunchIds.size >= max) {
      this.lifecycle.finishStage(record.stage.id, 'failed');
      this.publishState('updated');
      return;
    }
    this.publishState('updated');
  }

  private publishState(phase: ProfileStageStateEvent['phase']): void {
    const profileId = this.plan.orchestrationProfileId;
    const strategyId = this.plan.strategyId;
    if (!profileId || !strategyId) return;
    const states = new Map(this.lifecycle.snapshot().map((stage) => [stage.id, stage]));
    this.hooks.onStateChange?.({
      phase,
      profileId,
      strategyId,
      selectionSource: this.plan.selectionSource,
      stages: this.plan.stages.map((stage) => {
        const snapshot = states.get(stage.id);
        return {
          id: stage.id,
          state: snapshot?.state ?? 'planned',
          executor: stage.executor.kind,
          ...(stage.executor.kind === 'role' ? { roleId: stage.executor.roleId } : {}),
          skillIds: [...stage.skillIds],
          ...(this.activeStageId === stage.id && this.activeSkillId
            ? { activeSkillId: this.activeSkillId }
            : {}),
        };
      }),
    });
  }

  private result(input: {
    action: string;
    stage: ResolvedOrchestrationStage;
    activeSkill?: PrimaryStageSkillActivation;
    remainingSkillIds: string[];
  }): string {
    return JSON.stringify({
      ok: true,
      action: input.action,
      stageId: input.stage.id,
      objective: input.stage.objective,
      ...(input.activeSkill
        ? {
            activeSkill: input.activeSkill.id,
            instructions: input.activeSkill.instructions,
            allowedTools: input.activeSkill.allowedTools ?? null,
            disallowedTools: input.activeSkill.disallowedTools,
          }
        : {}),
      remainingSkillIds: input.remainingSkillIds,
      stages: this.lifecycle.snapshot(),
    }, null, 2);
  }
}

function parseAction(input: Record<string, unknown>): PrimaryStageAction {
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  const stageId = typeof input.stageId === 'string' ? input.stageId.trim() : '';
  const skillId = typeof input.skillId === 'string' ? input.skillId.trim() : undefined;
  if (!stageId) {
    throw new PrimaryStageActionRejectedError(
      'invalid-action',
      'profile_stage requires a non-empty stageId.',
    );
  }
  if (action === 'begin' || action === 'complete') {
    return { action, stageId, ...(skillId ? { skillId } : {}) };
  }
  if (action === 'skip') return { action, stageId };
  throw new PrimaryStageActionRejectedError(
    'invalid-action',
    'profile_stage action must be begin, complete, or skip.',
  );
}

export function isPrimaryStageLifecycleError(error: unknown): boolean {
  return error instanceof PrimaryStageActionRejectedError
    || error instanceof OrchestrationStageLaunchRejectedError;
}

function copyStage(stage: ResolvedOrchestrationStage): ResolvedOrchestrationStage {
  return {
    ...stage,
    executor: { ...stage.executor },
    after: [...stage.after],
    skillIds: [...stage.skillIds],
    ...(stage.fanOut ? { fanOut: { ...stage.fanOut } } : {}),
    ...(stage.expectedOutput
      ? {
          expectedOutput: {
            contractId: stage.expectedOutput.contractId,
            requiredSections: [...stage.expectedOutput.requiredSections],
          },
        }
      : {}),
  };
}

function boundedAssignment(value?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > 4_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new PrimaryStageActionRejectedError(
      'invalid-action',
      'Delegated stage assignment must be at most 4000 safe text characters.',
    );
  }
  return normalized;
}
