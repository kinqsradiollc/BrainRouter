import fs from 'node:fs';
import { getCliStateFile, getSessionStateFile, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Persistent goal / continuation contract for the agent. Modeled after codex's
 * `/goal` (Codex 0.128+) — not just a sticky string. A goal carries:
 *
 *   - text:        the outcome that should be true when done
 *   - status:      active | paused | complete | blocked
 *   - budget:      iteration cap so auto-continuation can't burn tokens forever
 *   - timestamps:  startedAt, updatedAt, completedAt
 *   - blockedReason: filled when the agent calls `goal_blocked`
 *
 * Storage (per-session bucket):
 *   ~/.brainrouter/workspaces/<encoded>/cli/sessions/<encodedKey>/goal.json
 * Legacy fallback (pre-2026-05-21 builds):
 *   <workspace>/.brainrouter/cli/goal.json or its home equivalent
 *
 * Older builds wrote `{ text, setAt }`. `normalize()` fills in the missing
 * fields with defaults so resumed sessions don't crash on first read.
 */

export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked';

export interface GoalBudget {
  maxIterations: number;
  iterationsUsed: number;
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

function normalize(raw: Partial<Goal> | null | undefined): Goal | null {
  if (!raw || !raw.text || raw.text === '') return null;
  const setAt = raw.setAt ?? new Date().toISOString();
  return {
    text: raw.text,
    setAt,
    status: raw.status ?? 'active',
    budget: raw.budget ?? { maxIterations: DEFAULT_GOAL_BUDGET, iterationsUsed: 0 },
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

export function setGoal(
  workspaceRoot: string,
  text: string,
  sessionKey?: string,
  options: { maxIterations?: number } = {},
): Goal {
  const trimmed = text.trim();
  if (trimmed.length > GOAL_TEXT_MAX_CHARS) {
    throw new GoalTooLongError(trimmed.length);
  }
  const now = new Date().toISOString();
  const goal: Goal = {
    text: trimmed,
    setAt: now,
    status: 'active',
    budget: { maxIterations: options.maxIterations ?? DEFAULT_GOAL_BUDGET, iterationsUsed: 0 },
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

export function setGoalBudget(workspaceRoot: string, sessionKey: string | undefined, maxIterations: number): Goal | null {
  const current = readGoal(workspaceRoot, sessionKey);
  if (!current) return null;
  return patchGoal(workspaceRoot, sessionKey, {
    budget: { maxIterations: Math.max(1, maxIterations), iterationsUsed: current.budget.iterationsUsed },
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
 * True iff scheduling ONE MORE iteration would still fit inside the budget.
 *
 * The continuation loop ticks AFTER deciding to continue (so `iterationsUsed`
 * lags by one until the tick runs). To stop after exactly `maxIterations`
 * runs total, the predicate must ask "is (used+1) still within the cap?",
 * not "is (used) still under the cap?". The old form gave you N+1 runs.
 */
export function goalHasBudgetLeft(goal: Goal): boolean {
  return goal.budget.iterationsUsed + 1 < goal.budget.maxIterations;
}

export function formatGoalBlock(goal: Goal): string {
  const remaining = Math.max(0, goal.budget.maxIterations - goal.budget.iterationsUsed);
  return [
    `## Active Goal — ${goal.status.toUpperCase()}`,
    '',
    `**Outcome:** ${goal.text}`,
    `**Iteration:** ${goal.budget.iterationsUsed + 1} of ${goal.budget.maxIterations} (${remaining} remaining)`,
    `**Started:** ${goal.startedAt}`,
    goal.blockedReason ? `**Blocked because:** ${goal.blockedReason}` : '',
    '',
    'This goal is a persistent contract. After each turn the CLI may auto-continue',
    'you with another turn until the contract is satisfied. To complete the loop:',
    '',
    '- Call `goal_complete` with a 1–2 sentence evidence-based proof the outcome is met',
    '  (e.g. "tests/file_X.test.ts passes; `mobile/app.tsx` renders the route").',
    '- Call `goal_blocked` with a reason and the user input needed if no path remains.',
    '- Otherwise: take the next concrete tool action — read a file, write code, spawn a',
    '  worker child, run a verifier. **Prose-only responses ("I will continue") count as',
    '  a no-op and the CLI will NOT auto-continue after them** (anti-spin).',
    '',
    'Always audit the evidence before declaring complete — failing tests, missing files,',
    'or unverified claims mean the goal is NOT done yet.',
  ].filter(Boolean).join('\n');
}
