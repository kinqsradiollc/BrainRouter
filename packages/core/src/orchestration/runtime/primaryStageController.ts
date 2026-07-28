/**
 * Turn-owned controller for primary orchestration-profile stages.
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

export interface PrimaryStageSkillActivation {
  id: string;
  instructions: string;
  allowedTools?: string[];
  disallowedTools: string[];
}

export interface PrimaryStageControllerHooks {
  loadSkill(skillId: string): Promise<PrimaryStageSkillActivation>;
  setActiveSkill(skill: PrimaryStageSkillActivation | undefined): void;
}

export interface RequiredPrimaryStageAction {
  action: 'begin' | 'complete';
  stageId: string;
  skillId: string;
  optional: boolean;
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

export class PrimaryStageController {
  private readonly lifecycle: EphemeralOrchestrationPlanLifecycle;
  private readonly primaryStages = new Map<string, PrimaryStageRecord>();
  private activeStageId?: string;
  private activeSkillId?: string;

  constructor(
    readonly owner: Readonly<OrchestrationLifecycleOwner>,
    plan: Pick<ResolvedWorkspaceOrchestrationPlan, 'stages'>,
    private readonly hooks: PrimaryStageControllerHooks,
  ) {
    this.lifecycle = new EphemeralOrchestrationPlanLifecycle(owner, plan);
    for (const stage of plan.stages) {
      if (stage.executor.kind !== 'primary') continue;
      this.primaryStages.set(stage.id, {
        stage: {
          ...stage,
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
        },
        completedSkillIds: new Set(),
      });
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

  terminate(reason: OrchestrationLifecycleTerminationReason): void {
    this.clearActiveSkill();
    this.lifecycle.terminate(reason);
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
    return this.result({
      action: remainingSkillIds.length === 0 ? 'completed-stage' : 'completed-skill',
      stage: record.stage,
      remainingSkillIds,
    });
  }

  private skip(stageId: string): string {
    const record = this.requirePrimaryStage(stageId);
    if (!record.stage.optional) {
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
    const blockedBy = record.stage.after.find((dependencyId) => {
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
    return this.result({
      action: 'skipped-stage',
      stage: record.stage,
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
  }

  private clearActiveSkill(): void {
    this.activeSkillId = undefined;
    this.hooks.setActiveSkill(undefined);
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
