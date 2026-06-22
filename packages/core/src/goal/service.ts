/**
 * Goal service (ADR-008, Wave 2) — a per-workspace port over the goal store.
 * Goals are scoped by (workspaceRoot, sessionKey?), so the facade binds
 * `workspaceRoot` at construction and keeps `sessionKey` a per-call argument.
 * Additive and behaviour-preserving: every method delegates to the existing
 * goalStore functions; the pure budget predicates are folded in because they
 * read a Goal this service owns. No logic moved or removed.
 */
import {
  readGoal, setGoal, clearGoal, pauseGoal, resumeGoal, completeGoal, blockGoal,
  usageLimitGoal, setGoalBudget, setGoalTokenBudget, tickGoalIteration, addGoalTokens,
  editGoal, goalHasBudgetLeft, goalIsOnFinalBudgetTurn, type Goal,
} from "./goalStore.js";

/** Options accepted by {@link IGoalService.set} — the store's exact shape. */
export type SetGoalOptions = Parameters<typeof setGoal>[3];
/** Patch accepted by {@link IGoalService.edit} — the store's exact shape. */
export type EditGoalPatch = Parameters<typeof editGoal>[2];

/** The goal-lifecycle store contract, scoped to one workspace. */
export interface IGoalService {
  read(sessionKey?: string): Goal | null;
  set(text: string, sessionKey?: string, options?: SetGoalOptions): Goal;
  clear(sessionKey?: string): void;
  pause(sessionKey?: string): Goal | null;
  resume(sessionKey?: string): Goal | null;
  complete(sessionKey?: string, proof?: string): Goal | null;
  block(sessionKey: string | undefined, reason: string): Goal | null;
  usageLimit(sessionKey: string | undefined, reason: string): Goal | null;
  setBudget(sessionKey: string | undefined, maxIterations: number): Goal | null;
  setTokenBudget(sessionKey: string | undefined, maxTokens: number): Goal | null;
  tickIteration(sessionKey?: string): Goal | null;
  addTokens(sessionKey: string | undefined, delta: number): Goal | null;
  edit(sessionKey: string | undefined, patch: EditGoalPatch): Goal | null;
  hasBudgetLeft(goal: Goal): boolean;
  isOnFinalBudgetTurn(goal: Goal): boolean;
}

/** {@link IGoalService} backed by the in-process goal store — delegates only. */
export class GoalService implements IGoalService {
  constructor(private readonly workspaceRoot: string) {}
  read(sessionKey?: string): Goal | null {
    return readGoal(this.workspaceRoot, sessionKey);
  }
  set(text: string, sessionKey?: string, options?: SetGoalOptions): Goal {
    return options === undefined
      ? setGoal(this.workspaceRoot, text, sessionKey)
      : setGoal(this.workspaceRoot, text, sessionKey, options);
  }
  clear(sessionKey?: string): void {
    return clearGoal(this.workspaceRoot, sessionKey);
  }
  pause(sessionKey?: string): Goal | null {
    return pauseGoal(this.workspaceRoot, sessionKey);
  }
  resume(sessionKey?: string): Goal | null {
    return resumeGoal(this.workspaceRoot, sessionKey);
  }
  complete(sessionKey?: string, proof?: string): Goal | null {
    return completeGoal(this.workspaceRoot, sessionKey, proof);
  }
  block(sessionKey: string | undefined, reason: string): Goal | null {
    return blockGoal(this.workspaceRoot, sessionKey, reason);
  }
  usageLimit(sessionKey: string | undefined, reason: string): Goal | null {
    return usageLimitGoal(this.workspaceRoot, sessionKey, reason);
  }
  setBudget(sessionKey: string | undefined, maxIterations: number): Goal | null {
    return setGoalBudget(this.workspaceRoot, sessionKey, maxIterations);
  }
  setTokenBudget(sessionKey: string | undefined, maxTokens: number): Goal | null {
    return setGoalTokenBudget(this.workspaceRoot, sessionKey, maxTokens);
  }
  tickIteration(sessionKey?: string): Goal | null {
    return tickGoalIteration(this.workspaceRoot, sessionKey);
  }
  addTokens(sessionKey: string | undefined, delta: number): Goal | null {
    return addGoalTokens(this.workspaceRoot, sessionKey, delta);
  }
  edit(sessionKey: string | undefined, patch: EditGoalPatch): Goal | null {
    return editGoal(this.workspaceRoot, sessionKey, patch);
  }
  hasBudgetLeft(goal: Goal): boolean {
    return goalHasBudgetLeft(goal);
  }
  isOnFinalBudgetTurn(goal: Goal): boolean {
    return goalIsOnFinalBudgetTurn(goal);
  }
}

/** Construct a goal service bound to a workspace. */
export function createGoalService(workspaceRoot: string): IGoalService {
  return new GoalService(workspaceRoot);
}
