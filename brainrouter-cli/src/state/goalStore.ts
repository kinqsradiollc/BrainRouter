import fs from 'node:fs';
import { getCliStateFile, getSessionStateFile, readJsonFile, writeJsonFile } from './cliState.js';

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
 * Storage (per-session bucket):
 *   ~/.brainrouter/workspaces/<encoded>/cli/sessions/<encodedKey>/goal.json
 *
 * Legacy fallback paths exist for sessions created before per-session
 * goal isolation was added. normalize() fills missing fields with defaults
 * so resumed sessions don't crash on first read.
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

export const DEFAULT_GOAL_BUDGET = 10;

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

function normalize(raw: Partial<Goal> | null | undefined): Goal | null {
  if (!raw || !raw.text || raw.text === '') return null;
  const setAt = raw.setAt ?? new Date().toISOString();
  const budget: GoalBudget = raw.budget ?? { maxIterations: DEFAULT_GOAL_BUDGET, iterationsUsed: 0 };
  // Backfill tokensUsed for older goals so consumers can rely on the field
  // being a number when maxTokens is set later.
  if (budget.maxTokens && typeof budget.tokensUsed !== 'number') {
    budget.tokensUsed = 0;
  }
  return {
    text: raw.text,
    setAt,
    status: raw.status ?? 'active',
    budget,
    startedAt: raw.startedAt ?? setAt,
    updatedAt: raw.updatedAt ?? setAt,
    completedAt: raw.completedAt,
    blockedReason: raw.blockedReason,
  };
}

function resolveGoalFile(workspaceRoot: string, sessionKey?: string): string {
  if (sessionKey) {
    const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'goal.json');
    if (fs.existsSync(sessionPath)) return sessionPath;
  }
  return getCliStateFile(workspaceRoot, 'goal.json');
}

export function readGoal(workspaceRoot: string, sessionKey?: string): Goal | null {
  if (sessionKey) {
    const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'goal.json');
    if (fs.existsSync(sessionPath)) {
      return normalize(readJsonFile<Partial<Goal> | null>(sessionPath, null));
    }
  }
  const legacyPath = getCliStateFile(workspaceRoot, 'goal.json');
  if (fs.existsSync(legacyPath)) {
    return normalize(readJsonFile<Partial<Goal> | null>(legacyPath, null));
  }
  return null;
}

/**
 * Set a new active goal. Refuses to overwrite an in-progress goal (active,
 * paused, blocked, or usage_limited) unless `force: true` is passed. The
 * REPL catches the resulting GoalConflictError and prompts the user before
 * replacing. Replacing a `complete` goal is allowed silently — at that
 * point the prior goal isn't doing any work and a new one is just starting
 * fresh.
 */
export function setGoal(
  workspaceRoot: string,
  text: string,
  sessionKey?: string,
  options: { maxIterations?: number; maxTokens?: number; force?: boolean } = {},
): Goal {
  const trimmed = text.trim();
  if (trimmed.length > GOAL_TEXT_MAX_CHARS) {
    throw new GoalTooLongError(trimmed.length);
  }
  // Conflict detection: don't silently nuke an in-progress goal. The
  // `complete` status is exempt — the prior work is done, replacing it is
  // just starting fresh. The REPL layer handles the prompt and re-calls
  // with `force: true` once the user confirms.
  if (!options.force) {
    const existing = readGoal(workspaceRoot, sessionKey);
    if (existing && existing.status !== 'complete') {
      throw new GoalConflictError(existing);
    }
  }
  const now = new Date().toISOString();
  const goal: Goal = {
    text: trimmed,
    setAt: now,
    status: 'active',
    budget: {
      maxIterations: options.maxIterations ?? DEFAULT_GOAL_BUDGET,
      iterationsUsed: 0,
      ...(options.maxTokens ? { maxTokens: options.maxTokens, tokensUsed: 0 } : {}),
    },
    startedAt: now,
    updatedAt: now,
  };
  const filePath = sessionKey
    ? getSessionStateFile(workspaceRoot, sessionKey, 'goal.json')
    : getCliStateFile(workspaceRoot, 'goal.json');
  writeJsonFile(filePath, goal);
  return goal;
}

export function clearGoal(workspaceRoot: string, sessionKey?: string): void {
  if (sessionKey) {
    writeJsonFile(getSessionStateFile(workspaceRoot, sessionKey, 'goal.json'), null);
  }
  const legacy = getCliStateFile(workspaceRoot, 'goal.json');
  if (fs.existsSync(legacy)) {
    writeJsonFile(legacy, null);
  }
}

function patchGoal(
  workspaceRoot: string,
  sessionKey: string | undefined,
  patch: Partial<Goal>,
): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  const next: Goal = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(resolveGoalFile(workspaceRoot, sessionKey), next);
  return next;
}

export function pauseGoal(workspaceRoot: string, sessionKey?: string): Goal | null {
  return patchGoal(workspaceRoot, sessionKey, { status: 'paused' });
}

export function resumeGoal(workspaceRoot: string, sessionKey?: string): Goal | null {
  return patchGoal(workspaceRoot, sessionKey, { status: 'active' });
}

export function completeGoal(workspaceRoot: string, sessionKey?: string, proof?: string): Goal | null {
  return patchGoal(workspaceRoot, sessionKey, {
    status: 'complete',
    completedAt: new Date().toISOString(),
    blockedReason: proof,
  });
}

export function blockGoal(workspaceRoot: string, sessionKey: string | undefined, reason: string): Goal | null {
  return patchGoal(workspaceRoot, sessionKey, { status: 'blocked', blockedReason: reason });
}

/**
 * Mark the goal as `usage_limited` — distinct from paused (user-initiated)
 * and blocked (agent gave up). Used when the iteration or token budget
 * runs out. The user can resume after raising the budget; the loop won't
 * fire another turn on its own until they do.
 */
export function usageLimitGoal(workspaceRoot: string, sessionKey: string | undefined, reason: string): Goal | null {
  return patchGoal(workspaceRoot, sessionKey, { status: 'usage_limited', blockedReason: reason });
}

export function setGoalBudget(workspaceRoot: string, sessionKey: string | undefined, maxIterations: number): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  return patchGoal(workspaceRoot, sessionKey, {
    budget: { ...current.budget, maxIterations: Math.max(1, maxIterations) },
  });
}

/**
 * Set or clear the optional token budget. Pass `0` (or any negative) to
 * clear; positive integers set the cap. Resets tokensUsed to 0 when first
 * enabling so the goal doesn't immediately appear exhausted.
 */
export function setGoalTokenBudget(
  workspaceRoot: string,
  sessionKey: string | undefined,
  maxTokens: number,
): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  if (maxTokens <= 0) {
    const { maxTokens: _drop, tokensUsed: _drop2, ...rest } = current.budget;
    return patchGoal(workspaceRoot, sessionKey, { budget: rest });
  }
  return patchGoal(workspaceRoot, sessionKey, {
    budget: { ...current.budget, maxTokens, tokensUsed: current.budget.tokensUsed ?? 0 },
  });
}

export function tickGoalIteration(workspaceRoot: string, sessionKey?: string): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  return patchGoal(workspaceRoot, sessionKey, {
    budget: { ...current.budget, iterationsUsed: current.budget.iterationsUsed + 1 },
  });
}

/**
 * Add `delta` tokens to the goal's running tally. No-op if a goal has no
 * token budget set. Returns the updated Goal so callers can decide whether
 * to transition to `usage_limited` afterwards.
 */
export function addGoalTokens(
  workspaceRoot: string,
  sessionKey: string | undefined,
  delta: number,
): Goal | null {
  if (!Number.isFinite(delta) || delta <= 0) return readGoal(workspaceRoot, sessionKey);
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current || !current.budget.maxTokens) return current;
  return patchGoal(workspaceRoot, sessionKey, {
    budget: {
      ...current.budget,
      tokensUsed: (current.budget.tokensUsed ?? 0) + delta,
    },
  });
}

/**
 * Unified update entrypoint. Lets callers mutate text/status/budget in a
 * single call instead of stringing pause→budget→resume together. Used by
 * the `/goal edit` REPL subcommand.
 */
export function editGoal(
  workspaceRoot: string,
  sessionKey: string | undefined,
  patch: {
    text?: string;
    status?: GoalStatus;
    maxIterations?: number;
    maxTokens?: number;
  },
): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  if (patch.text !== undefined) {
    const trimmed = patch.text.trim();
    if (trimmed.length > GOAL_TEXT_MAX_CHARS) {
      throw new GoalTooLongError(trimmed.length);
    }
    if (!trimmed) {
      throw new Error('Cannot set goal text to empty. Use /goal clear instead.');
    }
  }
  const nextBudget: GoalBudget = { ...current.budget };
  if (patch.maxIterations !== undefined && patch.maxIterations > 0) {
    nextBudget.maxIterations = Math.floor(patch.maxIterations);
  }
  if (patch.maxTokens !== undefined) {
    if (patch.maxTokens <= 0) {
      delete nextBudget.maxTokens;
      delete nextBudget.tokensUsed;
    } else {
      nextBudget.maxTokens = Math.floor(patch.maxTokens);
      nextBudget.tokensUsed = nextBudget.tokensUsed ?? 0;
    }
  }
  return patchGoal(workspaceRoot, sessionKey, {
    text: patch.text !== undefined ? patch.text.trim() : current.text,
    status: patch.status ?? current.status,
    budget: nextBudget,
  });
}

/**
 * True iff scheduling ONE MORE iteration would still fit inside BOTH the
 * iteration cap and (if set) the token cap.
 *
 * The continuation loop ticks AFTER deciding to continue (so `iterationsUsed`
 * lags by one until the tick runs). To stop after exactly `maxIterations`
 * runs total, the predicate must ask "is (used+1) still within the cap?",
 * not "is (used) still under the cap?". The old form gave you N+1 runs.
 *
 * Token budget is a hard "currently used vs cap" check — we can't know the
 * next turn's token cost ahead of time, so we just refuse to schedule when
 * we're already at or past the cap.
 */
export function goalHasBudgetLeft(goal: Goal): boolean {
  if (goal.budget.iterationsUsed + 1 >= goal.budget.maxIterations) return false;
  if (typeof goal.budget.maxTokens === 'number' && goal.budget.maxTokens > 0) {
    if ((goal.budget.tokensUsed ?? 0) >= goal.budget.maxTokens) return false;
  }
  return true;
}

/**
 * True iff this is the FINAL turn within the budget — i.e. the iteration
 * tick is about to land but one more after it would exceed the cap. The
 * continuation loop uses this to inject a "wrap up gracefully" steering
 * message so the model lands soft instead of being interrupted mid-thought.
 *
 * Specifically: after this turn's tick, iterationsUsed will equal
 * maxIterations - 1, so `goalHasBudgetLeft` will return false on the next
 * decision. We detect that ahead of time by checking before the tick.
 */
export function goalIsOnFinalBudgetTurn(goal: Goal): boolean {
  if (goal.budget.iterationsUsed + 2 >= goal.budget.maxIterations) return true;
  if (typeof goal.budget.maxTokens === 'number' && goal.budget.maxTokens > 0) {
    const remaining = goal.budget.maxTokens - (goal.budget.tokensUsed ?? 0);
    // Heuristic: if more than 80% of the token budget is consumed, treat
    // this as the final turn so the model can wrap up. Avoids the edge
    // case where one big turn would tip us over without warning.
    if (remaining <= goal.budget.maxTokens * 0.2) return true;
  }
  return false;
}

/**
 * Wrap-up steering message injected on the final-budget turn. The agent
 * loop pushes this into the chat history as a system message so the model
 * pivots from "continue investigating" to "consolidate and report." Plain
 * directive, no role-play.
 *
 * The message specifically reports WHICH cap is tight (iterations, tokens,
 * or both) so the model doesn't get told "one turn left" when it actually
 * has many iterations remaining but is near the token cap, or vice versa.
 * Earlier versions hardcoded the iteration framing even when only the
 * token heuristic tripped, which misled the model on token-budgeted runs.
 */
export function buildBudgetSteeringMessage(goal: Goal): string {
  const iterationsRemaining = Math.max(0, goal.budget.maxIterations - goal.budget.iterationsUsed - 1);
  const iterationTight = goal.budget.iterationsUsed + 2 >= goal.budget.maxIterations;
  const tokensTight =
    typeof goal.budget.maxTokens === 'number' &&
    goal.budget.maxTokens > 0 &&
    (goal.budget.maxTokens - (goal.budget.tokensUsed ?? 0)) <= goal.budget.maxTokens * 0.2;

  let headline: string;
  if (iterationTight && tokensTight) {
    const tokensRemaining = (goal.budget.maxTokens ?? 0) - (goal.budget.tokensUsed ?? 0);
    headline =
      `Both budgets are nearly exhausted: ${iterationsRemaining} iteration(s) remaining ` +
      `(cap ${goal.budget.maxIterations}) and ~${tokensRemaining.toLocaleString()} tokens remaining ` +
      `(cap ${(goal.budget.maxTokens ?? 0).toLocaleString()}). This is your last turn.`;
  } else if (iterationTight) {
    const tokensClause = goal.budget.maxTokens
      ? ` (tokens still have headroom: ${((goal.budget.maxTokens ?? 0) - (goal.budget.tokensUsed ?? 0)).toLocaleString()} of ${(goal.budget.maxTokens ?? 0).toLocaleString()} remaining)`
      : '';
    headline =
      `You have ${iterationsRemaining || 1} iteration(s) left within the goal's iteration budget ` +
      `(cap ${goal.budget.maxIterations})${tokensClause}. This is your last turn.`;
  } else {
    // Token cap is the trigger; iterations may still have plenty of headroom.
    const tokensUsed = goal.budget.tokensUsed ?? 0;
    const tokensCap = goal.budget.maxTokens ?? 0;
    const tokensRemaining = Math.max(0, tokensCap - tokensUsed);
    headline =
      `You're at ${tokensUsed.toLocaleString()}/${tokensCap.toLocaleString()} tokens of the goal's budget ` +
      `(${Math.round((tokensUsed / Math.max(1, tokensCap)) * 100)}% used) with only ~${tokensRemaining.toLocaleString()} tokens remaining. ` +
      `Iteration count still has headroom but the token cap will trip before another full turn fits.`;
  }

  return [
    '## Budget about to run out',
    headline,
    'Do not start any new long-running investigation, spawn new children, or read more files.',
    'Instead:',
    '1. Synthesize what you already know into a concise wrap-up.',
    '2. If you have enough evidence the goal is satisfied, call `goal_complete` with the proof.',
    '3. If you do not, call `goal_blocked` with the specific unblocker the user needs to provide.',
    '4. If you need more budget, say so explicitly so the user can extend it.',
  ].join('\n');
}

export function formatGoalBlock(goal: Goal): string {
  const remaining = Math.max(0, goal.budget.maxIterations - goal.budget.iterationsUsed);
  const tokenLine = goal.budget.maxTokens
    ? `**Tokens:** ${(goal.budget.tokensUsed ?? 0).toLocaleString()} of ${goal.budget.maxTokens.toLocaleString()} used`
    : '';
  return [
    `## Active Goal — ${goal.status.toUpperCase().replace('_', ' ')}`,
    '',
    `**Outcome:** ${goal.text}`,
    `**Iteration:** ${goal.budget.iterationsUsed + 1} of ${goal.budget.maxIterations} (${remaining} remaining)`,
    tokenLine,
    `**Started:** ${goal.startedAt}`,
    goal.blockedReason ? `**Reason:** ${goal.blockedReason}` : '',
    '',
    'This goal is a persistent contract. After each turn the CLI may auto-continue',
    'you with another turn until the contract is satisfied. To complete the loop:',
    '',
    '- **When you call `goal_complete` / `goal_blocked`, the SAME assistant message',
    '  MUST contain the user-visible deliverable as prose** — the actual answer,',
    '  analysis, report, or summary the user asked for. The `proof` / `reason` fields',
    '  are short audit metadata, NOT the deliverable. Final-turn shape:',
    '  `<prose answer the user reads>` → `goal_complete({proof: "<short audit line>"})`.',
    '  If you skip the prose, the user sees only a placeholder and your work is invisible.',
    '- **Plan honesty:** before `goal_complete`, every item in your active plan',
    '  (from `update_plan`) MUST be marked `completed`. The CLI hard-refuses',
    '  goal_complete while pending / in_progress items remain. If you finished',
    '  the work, call `update_plan` first to mark items done. If you decided to',
    '  drop items mid-flight, mark them `completed` with a brief rationale in the',
    '  step text — the plan is your audit record, leaving items pending while',
    '  declaring done is misleading.',
    '- Call `goal_complete` with a 1–2 sentence evidence-based proof the outcome is met',
    '  (e.g. "tests/file_X.test.ts passes; `mobile/app.tsx` renders the route").',
    '- Call `goal_blocked` with a reason and the user input needed if no path remains.',
    '- Otherwise (mid-goal turns): take the next concrete tool action — read a file,',
    '  write code, spawn a worker child, run a verifier. **Prose-only intermediate',
    '  responses ("I will continue") count as a no-op and the CLI will NOT auto-continue',
    '  after them** (anti-spin). This anti-spin rule covers INTERMEDIATE turns only —',
    '  the final goal-completing turn MUST include prose alongside the tool call.',
    '',
    'Always audit the evidence before declaring complete — failing tests, missing files,',
    'or unverified claims mean the goal is NOT done yet.',
  ].filter(Boolean).join('\n');
}
