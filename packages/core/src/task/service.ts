/**
 * Task (plan) service (ADR-008, Wave 2) — a per-workspace port over the plan
 * store. Plans are scoped by (workspaceRoot, sessionKey?), so the facade binds
 * `workspaceRoot` and keeps `sessionKey` a per-call argument. Additive and
 * behaviour-preserving: every method delegates to the existing taskStore
 * functions; `format` is the one pure helper folded in. No logic moved or removed.
 */
import {
  readPlan, updatePlan, seedPlanFromRequirement, formatPlan, type PlanState,
} from "./taskStore.js";

/** Input accepted by {@link ITaskService.update} — the store's exact shape. */
export type UpdatePlanInput = Parameters<typeof updatePlan>[1];
/** Requirement seed accepted by {@link ITaskService.seedFromRequirement}. */
export type PlanRequirementSeed = Parameters<typeof seedPlanFromRequirement>[1];

/** The plan store contract, scoped to one workspace. */
export interface ITaskService {
  read(sessionKey?: string): PlanState;
  update(input: UpdatePlanInput, sessionKey?: string): PlanState;
  seedFromRequirement(req: PlanRequirementSeed, sessionKey?: string): PlanState;
  format(state: PlanState): string;
}

/** {@link ITaskService} backed by the in-process plan store — delegates only. */
export class TaskService implements ITaskService {
  constructor(private readonly workspaceRoot: string) {}
  read(sessionKey?: string): PlanState {
    return readPlan(this.workspaceRoot, sessionKey);
  }
  update(input: UpdatePlanInput, sessionKey?: string): PlanState {
    return updatePlan(this.workspaceRoot, input, sessionKey);
  }
  seedFromRequirement(req: PlanRequirementSeed, sessionKey?: string): PlanState {
    return seedPlanFromRequirement(this.workspaceRoot, req, sessionKey);
  }
  format(state: PlanState): string {
    return formatPlan(state);
  }
}

/** Construct a task (plan) service bound to a workspace. */
export function createTaskService(workspaceRoot: string): ITaskService {
  return new TaskService(workspaceRoot);
}
