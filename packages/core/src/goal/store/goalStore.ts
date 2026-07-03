import fs from 'node:fs';
import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import {
  DEFAULT_GOAL_BUDGET,
  GOAL_TEXT_MAX_CHARS,
  GoalConflictError,
  GoalTooLongError,
  resolveGoalScope,
  type Goal,
  type GoalBudget,
  type GoalStatus,
} from '../model/goalModel.js';

/**
 * Persistent goal / continuation store for the agent. This module owns the
 * on-disk CRUD for a {@link Goal}: read, write, lifecycle transitions, and
 * budget mutations. The value types, budget predicates, goal-anchor
 * formatter, and continuation decision live in sibling modules and are
 * re-exported below so consumers that import from `goal/goalStore.js`
 * (or the `@kinqs/brainrouter-core/goal` barrel) see the same public
 * surface as before the split.
 *
 * See `goalModel.ts` for the full storage / priority-chain contract.
 */

// Re-export the extracted subsystem so the public surface of
// `goal/goalStore.js` is unchanged after the split.
export * from '../model/goalModel.js';
export * from '../budget/goalBudget.js';
export * from '../prompt/goalFormat.js';
export * from '../prompt/goalContinuation.js';

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

export function readGoal(workspaceRoot: string, sessionKey?: string): Goal | null {
  const scope = resolveGoalScope(workspaceRoot, sessionKey);
  if (!fs.existsSync(scope.path)) return null;
  return normalize(readJsonFile<Partial<Goal> | null>(scope.path, null));
}

/**
 * Retire a stale workspace-level `goal.json` the moment we write to a
 * higher-priority scope. We DELETE it rather than archiving into a
 * `.brainrouter.migrated/` folder — leaving that archive behind was the
 * source of stray project-tree clutter. The goal content the caller cares
 * about has already been written to the new scope by the time this runs, so
 * the legacy file is genuinely disposable. Best-effort: never let a failed
 * unlink block a goal write.
 */
function retireLegacyGoal(workspaceRoot: string): void {
  const legacyPath = getStateFile(workspaceRoot, 'goal.json');
  if (!fs.existsSync(legacyPath)) return;
  try {
    fs.rmSync(legacyPath, { force: true });
  } catch {
    // best-effort: fall back to blanking the file so a future no-session
    // read can't resurface the stale goal.
    try {
      writeJsonFile(legacyPath, null);
    } catch {
      /* give up silently */
    }
  }
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
  const scope = resolveGoalScope(workspaceRoot, sessionKey);
  // Retire any stale workspace-level goal.json the moment we write to a
  // non-legacy scope (workflow OR session). This preserves the Item 1 fix:
  // never leave the legacy file where a future session would re-pick it up —
  // and does it without creating a `.brainrouter.migrated/` archive.
  if (scope.scope !== 'legacy') {
    retireLegacyGoal(workspaceRoot);
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
  writeJsonFile(scope.path, goal);
  return goal;
}

export function clearGoal(workspaceRoot: string, sessionKey?: string): void {
  const scope = resolveGoalScope(workspaceRoot, sessionKey);
  writeJsonFile(scope.path, null);
  // Also clear the legacy workspace file when we're operating on a higher-
  // priority scope — leaving it behind would let a future no-sessionKey
  // read resurface a stale goal.
  if (scope.scope !== 'legacy') {
    const legacy = getStateFile(workspaceRoot, 'goal.json');
    if (fs.existsSync(legacy)) writeJsonFile(legacy, null);
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
  writeJsonFile(resolveGoalScope(workspaceRoot, sessionKey).path, next);
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
