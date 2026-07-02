import { getStateFile, getSessionStateFile } from '../storage/store.js';

/**
 * Persistent goal / continuation contract for the agent. A goal is not just
 * a sticky string — it carries lifecycle status, a budget that bounds how
 * far auto-continuation will go, and timestamps so resumed sessions know
 * exactly where they left off.
 *
 *   - text:           the outcome that should be true when done
 *   - status:         active | paused | complete | blocked | usage_limited
 *   - budget:         iteration AND optional token caps; auto-continuation
 *                     halts (and the goal moves to `usage_limited`) when
 *                     either is exhausted
 *   - timestamps:     startedAt, updatedAt, completedAt
 *   - blockedReason:  filled when the agent calls goal_blocked
 *
 * Status semantics:
 *   - active         — continuation loop is allowed to fire next turn
 *   - paused         — user-initiated suspend; resume re-arms the loop
 *   - complete       — outcome satisfied; loop stops permanently
 *   - blocked        — agent reported a hard impasse (missing data, external
 *                      dep); loop stops until user intervenes
 *   - usage_limited  — budget (iterations or tokens) exhausted; resumable
 *                      after raising the budget. NEW compared to the old
 *                      paused/blocked-only model: lets the UI distinguish
 *                      "you ran out of room" from "user paused" from
 *                      "agent gave up."
 *
 * Storage (priority chain — see `resolveGoalScope`):
 *   1. Workflow bound: `<workspace>/.brainrouter/workflows/<slug>/goal.json`
 *      (lives in the committable workflow folder so the goal travels with
 *      the spec / tasks / walkthrough).
 *   2. No workflow, session-scoped:
 *      `~/.brainrouter/workspaces/<encoded>/cli/sessions/<encodedKey>/goal.json`
 *   3. Back-compat (no workflow, no sessionKey):
 *      `~/.brainrouter/workspaces/<encoded>/cli/goal.json`
 *
 * Session-scoped reads stay isolated (Item 1 invariant — never fall back to
 * a prior session's goal). Workflow-bound reads stay isolated by workflow
 * (Item 3 invariant — switching workflows swaps which goal you see).
 * normalize() fills missing fields with defaults so resumed sessions don't
 * crash on first read.
 */

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'usage_limited';

/** A pausing status is one where continuation is halted but resumable. */
export const PAUSING_STATUSES: readonly GoalStatus[] = ['paused', 'blocked', 'usage_limited'];

export interface GoalBudget {
  maxIterations: number;
  iterationsUsed: number;
  /**
   * Optional cumulative-token cap. When set, each turn's prompt+completion
   * tokens accumulate into `tokensUsed`; once `tokensUsed >= maxTokens` the
   * goal moves to `usage_limited` instead of just consuming another
   * iteration. Lets users protect a fixed dollar budget without having to
   * estimate the iteration count by hand.
   */
  maxTokens?: number;
  tokensUsed?: number;
}

export interface Goal {
  text: string;
  setAt: string;
  status: GoalStatus;
  budget: GoalBudget;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedReason?: string;
}

/**
 * Default iteration cap when the user doesn't pass one.
 *
 * Set to a very high number (effectively "unlimited" for any real task)
 * rather than a tight 10. Rationale: the goal lifecycle has three
 * independent safety nets that already prevent runaway loops —
 *   1. Anti-spin   — a turn that made zero tool calls doesn't continue
 *   2. Repeat-loop — calling the same tool with identical args 3× errors
 *   3. Manual stop — Ctrl-C, /goal pause, /goal clear
 *
 * A hard iteration cap on top of those is overly paternalistic for users
 * running local models (no $ cost) and is easily lifted with /goal budget
 * <n> when wanted. Display layers should treat any value >= UNLIMITED_THRESHOLD
 * as "unlimited" for friendlier UX.
 */
export const DEFAULT_GOAL_BUDGET = 1_000_000;
export const UNLIMITED_BUDGET_THRESHOLD = 100_000;

/** Format helper — used by REPL display + status output. */
export function formatBudget(maxIterations: number): string {
  return maxIterations >= UNLIMITED_BUDGET_THRESHOLD ? 'unlimited' : String(maxIterations);
}

/**
 * Hard cap on the goal text length. A goal is supposed to be a 1–3 sentence
 * outcome statement; multi-thousand-character pastes (e.g. full chat logs)
 * derail every subsequent turn because the goal block is re-injected into
 * the system prompt on EVERY iteration.
 */
export const GOAL_TEXT_MAX_CHARS = 4000;

export class GoalTooLongError extends Error {
  constructor(public readonly length: number) {
    super(
      `Goal condition is limited to ${GOAL_TEXT_MAX_CHARS} characters (got ${length}). ` +
      `Trim it to a 1–3 sentence outcome statement.`
    );
    this.name = 'GoalTooLongError';
  }
}

/**
 * Thrown when `setGoal` would overwrite a non-complete existing goal and
 * the caller didn't pass `force: true`. The REPL catches this and prompts
 * the user before replacing — interrupting in-flight work without
 * confirmation is one of the easiest ways to lose progress.
 *
 * A `complete` goal does NOT raise this — replacing a finished goal is
 * just starting fresh, no work is at risk.
 */
export class GoalConflictError extends Error {
  constructor(public readonly existing: Goal) {
    // Use status-aware wording. The previous "already active" phrasing was
    // misleading when the existing goal was paused, blocked, or
    // usage_limited — the REPL surfaces this message verbatim and users
    // would see "already active" for a goal they explicitly paused. Now
    // the message reflects the actual current state.
    const statusLabel = existing.status.replace('_', ' ');
    const inProgressClause = existing.status === 'active'
      ? 'is in progress'
      : `exists with status: ${statusLabel}`;
    super(
      `A goal already ${inProgressClause}. ` +
      `Pass force=true to replace it (REPL will prompt for confirmation first).`,
    );
    this.name = 'GoalConflictError';
  }
}

/**
 * Where the agent's goal lives RIGHT NOW. The priority chain — a
 * fallback-provider walk (guard clauses that early-return per layer
 * rather than a single flat loop) — is:
 *
 *   1. workflow scope — a workflow is bound via `current-workflow.json`
 *      (the per-user CLI pointer). Goal lives at `<workflow>/goal.json`
 *      next to spec.md / tasks.md / meta.json. Switching workflows carries
 *      the goal with the folder.
 *   2. session scope — no workflow bound but a sessionKey is supplied
 *      (the post-Item-1 default). Goal lives at
 *      `<cliStateDir>/sessions/<encodedKey>/goal.json` — strictly per
 *      session, never falls back to a different session's file.
 *   3. legacy scope — no workflow, no sessionKey. Used by the very-old
 *      single-process call sites that haven't been migrated yet (and by
 *      back-compat reads of pre-0.3.5 workspace-level goal.json files).
 *
 * Every read/write entrypoint routes through this single resolver so the
 * priority chain has exactly one decision point. Callers don't decide where
 * to look; they get a path + scope tag and act on it.
 */
export type GoalScope =
  | { scope: 'session'; sessionKey: string; path: string }
  | { scope: 'legacy'; path: string };

/**
 * Resolve the on-disk location where the active goal for this CLI process
 * lives.
 *
 * **Design (0.3.6 decouple-goal-from-workflow, supersedes Item 3):** goal
 * is **always per-session**. Workflows are durable artifact folders
 * (spec.md, tasks.md, walkthrough.md, meta.json) that have nothing to do
 * with the agent's autonomy primitive. The earlier Item 3 design coupled
 * the two by storing goal state inside `<workflow>/goal.json`, which
 * meant any two CLI sessions in the same workspace that happened to land
 * on the same workflow shared a goal — silently reintroducing the
 * cross-session leak PR #26 had fixed. We removed that coupling
 * entirely: workflows are storage, goals are runtime, no overlap.
 *
 * Priority chain:
 *   1. Session-scoped — `<session>/goal.json`. The normal case.
 *   2. Legacy — `<cli-state>/goal.json`. Only hit by callers without a
 *      sessionKey (rare; mostly tooling paths that pre-date Item 1).
 */
export function resolveGoalScope(workspaceRoot: string, sessionKey?: string): GoalScope {
  if (sessionKey) {
    return {
      scope: 'session',
      sessionKey,
      path: getSessionStateFile(workspaceRoot, sessionKey, 'goal.json'),
    };
  }
  return { scope: 'legacy', path: getStateFile(workspaceRoot, 'goal.json') };
}
