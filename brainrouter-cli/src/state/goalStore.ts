import fs from 'node:fs';
import path from 'node:path';
import { getCliStateDir, getCliStateFile, getSessionStateFile, readJsonFile, writeJsonFile } from './cliState.js';
import { getCurrentWorkflow, getWorkflowGoalFile } from './workflowArtifacts.js';

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

/**
 * Where the agent's goal lives RIGHT NOW. The priority chain — adapted from
 * openSrc/agentmemory's fallback-provider walk (guard clauses that early-
 * return per layer rather than a single flat loop) — is:
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
  | { scope: 'workflow'; slug: string; path: string }
  | { scope: 'session'; sessionKey: string; path: string }
  | { scope: 'legacy'; path: string };

export function resolveGoalScope(workspaceRoot: string, sessionKey?: string): GoalScope {
  // Priority 1: workflow-bound — but only via the SESSION-LEVEL pointer.
  //
  // Pre-9d-bugfix: `getCurrentWorkflow(workspaceRoot)` read the
  // workspace-level pointer, so every CLI session in the workspace saw
  // the same "current workflow" and (via this priority chain) shared its
  // goal. That silently reintroduced the Item 1 cross-session goal leak
  // whenever a workflow was bound: open a new CLI in a workspace where
  // an earlier session had run `/feature-dev` or `/spec`, and the new
  // session's first `/goal` would refuse with "A goal is already active"
  // because the workflow's `goal.json` was still on disk.
  //
  // 9d-bugfix: pass sessionKey through so `getCurrentWorkflow` reads
  // the per-session binding. A fresh session has no session-level
  // pointer → returns undefined → we fall through to session scope and
  // the session can `/goal` cleanly. Once the user explicitly runs
  // `/workflow switch <slug>` or `/feature-dev <feat>` IN THIS session,
  // the session pointer gets written and workflow-binding kicks in for
  // subsequent reads in the same session.
  try {
    const slug = getCurrentWorkflow(workspaceRoot, sessionKey);
    if (slug) {
      return { scope: 'workflow', slug, path: getWorkflowGoalFile(workspaceRoot, slug) };
    }
  } catch {
    // Workspace-local mkdirs occasionally race on first launch; fall through
    // to the safer session/legacy path rather than fail the read.
  }
  // Priority 2: session-scoped (the Item 1 fix — no cross-session leak).
  if (sessionKey) {
    return {
      scope: 'session',
      sessionKey,
      path: getSessionStateFile(workspaceRoot, sessionKey, 'goal.json'),
    };
  }
  // Priority 3: legacy workspace-level — back-compat for very old installs
  // and the no-session-key code paths.
  return { scope: 'legacy', path: getCliStateFile(workspaceRoot, 'goal.json') };
}

export function readGoal(workspaceRoot: string, sessionKey?: string): Goal | null {
  const scope = resolveGoalScope(workspaceRoot, sessionKey);
  if (!fs.existsSync(scope.path)) return null;
  return normalize(readJsonFile<Partial<Goal> | null>(scope.path, null));
}

/**
 * Read a specific workflow's goal regardless of the current pointer. Used
 * by `/workflows` to render the per-row goal column — the listing isn't
 * about "what's bound right now," it's about "what does each workflow
 * carry on disk."
 */
export function readWorkflowGoal(workspaceRoot: string, slug: string): Goal | null {
  const goalPath = getWorkflowGoalFile(workspaceRoot, slug);
  if (!fs.existsSync(goalPath)) return null;
  return normalize(readJsonFile<Partial<Goal> | null>(goalPath, null));
}

/**
 * One-column summary of a workflow's goal for the `/workflows` listing.
 * Mirrors statusline.ts' compact format — `goal:active N/M`, `goal:paused`,
 * `goal:limited` (the `usage_limited` status compressed to one word),
 * `goal:complete`, `goal:blocked`, or `goal:—` for no goal at all.
 *
 * Returns plain strings (no chalk) so the caller can apply theme colors
 * uniformly without the formatter caring about the color palette.
 */
export function formatWorkflowGoalColumn(goal: Goal | null): string {
  if (!goal) return 'goal:—';
  if (goal.status === 'active') {
    const cap = formatBudget(goal.budget.maxIterations);
    return `goal:active ${goal.budget.iterationsUsed}/${cap}`;
  }
  const label = goal.status === 'usage_limited' ? 'limited' : goal.status;
  return `goal:${label}`;
}

function archiveLegacyGoal(workspaceRoot: string): void {
  const legacyPath = getCliStateFile(workspaceRoot, 'goal.json');
  if (!fs.existsSync(legacyPath)) return;

  const archiveDir = path.join(getCliStateDir(workspaceRoot), '.brainrouter.migrated');
  fs.mkdirSync(archiveDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let archivePath = path.join(archiveDir, `legacy-goal-${stamp}.json`);
  let suffix = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDir, `legacy-goal-${stamp}-${suffix}.json`);
    suffix += 1;
  }

  fs.renameSync(legacyPath, archivePath);
}

/**
 * Archive a goal payload under `<cliStateDir>/.brainrouter.migrated/`. The
 * archive lives in the per-user CLI state tree, NOT inside the project
 * workspace — same invariant as Item 1's legacy-goal archive. We never
 * write `.migrated/` siblings into a workflow folder because those are
 * committable artifacts and `git status` shouldn't show migration debris.
 */
function archiveGoalPayload(
  workspaceRoot: string,
  prefix: string,
  qualifier: string,
  goal: Goal,
): string {
  const archiveDir = path.join(getCliStateDir(workspaceRoot), '.brainrouter.migrated');
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = qualifier.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  let archivePath = path.join(archiveDir, `${prefix}-${safe}-${stamp}.json`);
  let suffix = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveDir, `${prefix}-${safe}-${stamp}-${suffix}.json`);
    suffix += 1;
  }
  fs.writeFileSync(archivePath, JSON.stringify(goal, null, 2), 'utf8');
  return archivePath;
}

/**
 * Outcome of a session→workflow goal migration. `migrated: true` means the
 * session goal has been moved into the workflow folder and the session file
 * is cleared. `conflict` means the helper REFUSED to move because both sides
 * have non-complete goals — the caller must prompt the user and call
 * `applyMigrationResolution` with their choice.
 *
 * The conflict variant is named `'target-has-open-goal'` because the
 * trigger is "target goal exists AND is not complete" — any open status
 * (active / paused / blocked / usage_limited) counts. Only `complete`
 * targets are silently overwritten because the work is already finished.
 */
export interface GoalMigrationOutcome {
  migrated: boolean;
  conflict?: 'target-has-open-goal';
  /** Session-side goal that was the source (when present). */
  source?: Goal;
  /** Target-workflow goal already on disk (when present). */
  target?: Goal;
  /** Path of any archive written (loser of a conflict + winner-archived-too if forced). */
  archivedPath?: string;
}

export type GoalMigrationResolution = 'keep-target' | 'import-session';

/**
 * Refusal when `/workflow switch <slug>` would orphan an active goal. Two
 * active workflows pointing at independent threads of work shouldn't be
 * silently flipped between — the user must pause/complete one explicitly.
 * Mirrors `GoalConflictError`'s shape so the catch path in the slash
 * handler can take a parallel branch (print + exit cleanly, no rethrow).
 */
export class WorkflowConflictError extends Error {
  constructor(
    public readonly sourceSlug: string,
    public readonly sourceGoal: Goal,
    public readonly targetSlug: string,
    public readonly targetGoal: Goal,
  ) {
    super(
      `Source workflow "${sourceSlug}" has an active goal AND target workflow "${targetSlug}" has an active goal. ` +
      `Pause one first (/goal pause) before switching, or mark one /goal complete.`,
    );
    this.name = 'WorkflowConflictError';
  }
}

/**
 * Preview a `/workflow switch <slug>` without mutating anything. Returns
 * the source scope, the target's existing goal (if any), and whether the
 * caller will need to migrate a session goal into the target folder. Throws
 * `WorkflowConflictError` when BOTH the source and target are active
 * workflows with active goals.
 */
export function planWorkflowSwitch(
  workspaceRoot: string,
  sessionKey: string,
  targetSlug: string,
): { fromScope: GoalScope; sourceGoal: Goal | null; targetGoal: Goal | null; needsMigration: boolean } {
  const fromScope = resolveGoalScope(workspaceRoot, sessionKey);
  const targetPath = getWorkflowGoalFile(workspaceRoot, targetSlug);
  const targetGoal = normalize(
    fs.existsSync(targetPath) ? readJsonFile<Partial<Goal> | null>(targetPath, null) : null,
  );
  const sourceGoal = normalize(
    fs.existsSync(fromScope.path) ? readJsonFile<Partial<Goal> | null>(fromScope.path, null) : null,
  );

  if (
    fromScope.scope === 'workflow' &&
    fromScope.slug !== targetSlug &&
    sourceGoal?.status === 'active' &&
    targetGoal?.status === 'active'
  ) {
    throw new WorkflowConflictError(fromScope.slug, sourceGoal, targetSlug, targetGoal);
  }

  // Migration is needed only when the source is the SESSION bucket (not a
  // sibling workflow, not legacy) AND the session bucket has a goal worth
  // moving. workflow→workflow flips never trigger migration: each workflow
  // keeps its own goal exactly where it lives.
  const needsMigration = fromScope.scope === 'session' && !!sourceGoal;
  return { fromScope, sourceGoal, targetGoal, needsMigration };
}

/**
 * Migrate the session-scoped goal (if any) into the target workflow's
 * `goal.json` when `/workflow switch <slug>` fires. Idempotent — running
 * it twice with no session goal left is a no-op. Refuses to clobber a
 * non-complete target goal; surfaces `conflict: 'target-has-open-goal'`
 * (any status other than `complete` counts as "open" — see the
 * GoalMigrationOutcome doc) so the caller can `askYesNo` and route
 * through `applyMigrationResolution`.
 *
 * Why session→workflow only (not workflow→workflow)? Two workflows that
 * each carry their own goal are independent threads of work. Flipping the
 * pointer between them must not merge them — that's the Item 3 spec's
 * `WorkflowConflictError` job (Subtask 3). This helper is specifically for
 * "I was working in session-scope, now I'm binding a workflow."
 */
export function migrateSessionGoalToWorkflow(
  workspaceRoot: string,
  sessionKey: string,
  targetSlug: string,
): GoalMigrationOutcome {
  const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'goal.json');
  const sessionRaw = fs.existsSync(sessionPath)
    ? readJsonFile<Partial<Goal> | null>(sessionPath, null)
    : null;
  const sessionGoal = normalize(sessionRaw);
  if (!sessionGoal) return { migrated: false };

  const targetPath = getWorkflowGoalFile(workspaceRoot, targetSlug);
  const targetRaw = fs.existsSync(targetPath)
    ? readJsonFile<Partial<Goal> | null>(targetPath, null)
    : null;
  const targetGoal = normalize(targetRaw);

  if (targetGoal && targetGoal.status !== 'complete') {
    return {
      migrated: false,
      conflict: 'target-has-open-goal',
      source: sessionGoal,
      target: targetGoal,
    };
  }

  // Free path: no contender at the target (or its goal is complete).
  writeJsonFile(targetPath, sessionGoal);
  writeJsonFile(sessionPath, null);
  return { migrated: true, source: sessionGoal };
}

/**
 * Resolve a deferred migration after the user chooses between keeping the
 * target's goal or importing the session's. ALWAYS archives the losing side
 * to `<cliStateDir>/.brainrouter.migrated/` so nothing is silently lost.
 */
export function applyMigrationResolution(
  workspaceRoot: string,
  sessionKey: string,
  targetSlug: string,
  resolution: GoalMigrationResolution,
): GoalMigrationOutcome {
  const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'goal.json');
  const targetPath = getWorkflowGoalFile(workspaceRoot, targetSlug);
  const sessionGoal = normalize(
    fs.existsSync(sessionPath) ? readJsonFile<Partial<Goal> | null>(sessionPath, null) : null,
  );
  const targetGoal = normalize(
    fs.existsSync(targetPath) ? readJsonFile<Partial<Goal> | null>(targetPath, null) : null,
  );

  if (resolution === 'keep-target') {
    // Target wins. Archive the (losing) session goal so the user can
    // recover it if they regret the choice, then clear the session file
    // so the next switch is idempotent.
    if (sessionGoal) {
      const archivedPath = archiveGoalPayload(workspaceRoot, 'session-goal', sessionKey, sessionGoal);
      writeJsonFile(sessionPath, null);
      return { migrated: false, source: sessionGoal, target: targetGoal ?? undefined, archivedPath };
    }
    return { migrated: false, target: targetGoal ?? undefined };
  }
  // 'import-session' — session wins. Archive target's goal (the loser) then
  // overwrite. If the source somehow disappeared between conflict surfacing
  // and resolution, do nothing rather than blow away the target silently.
  if (!sessionGoal) {
    return { migrated: false, target: targetGoal ?? undefined };
  }
  let archivedPath: string | undefined;
  if (targetGoal) {
    archivedPath = archiveGoalPayload(workspaceRoot, 'workflow-goal', targetSlug, targetGoal);
  }
  writeJsonFile(targetPath, sessionGoal);
  writeJsonFile(sessionPath, null);
  return { migrated: true, source: sessionGoal, target: targetGoal ?? undefined, archivedPath };
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
  // Archive any stale workspace-level goal.json the moment we write to a
  // non-legacy scope (workflow OR session). This preserves the Item 1 fix:
  // never leave the legacy file where a future session would re-pick it up.
  if (scope.scope !== 'legacy') {
    archiveLegacyGoal(workspaceRoot);
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
    const legacy = getCliStateFile(workspaceRoot, 'goal.json');
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
 * Wrap-up directive folded into the goal-anchor block when the goal is on
 * its final budget turn. Reports WHICH cap is tight (iterations, tokens,
 * or both) so the model isn't told "one turn left" when it actually has
 * many iterations remaining but is near the token cap, or vice versa.
 *
 * Pre-0.3.6-9d this lived in its own `buildBudgetSteeringMessage` function
 * emitted as a separate `goal-budget-steering` tagged system message —
 * which meant the same iteration/token counts appeared in TWO places per
 * turn (the goal anchor AND the steering message). 9d folded the wrap-up
 * directive into the anchor itself; `formatGoalBlock(goal)` calls this
 * helper internally when `goalIsOnFinalBudgetTurn(goal)` returns true.
 */
function buildWrapUpDirective(goal: Goal): string {
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
    const tokensUsed = goal.budget.tokensUsed ?? 0;
    const tokensCap = goal.budget.maxTokens ?? 0;
    const tokensRemaining = Math.max(0, tokensCap - tokensUsed);
    headline =
      `You're at ${tokensUsed.toLocaleString()}/${tokensCap.toLocaleString()} tokens of the goal's budget ` +
      `(${Math.round((tokensUsed / Math.max(1, tokensCap)) * 100)}% used) with only ~${tokensRemaining.toLocaleString()} tokens remaining. ` +
      `Iteration count still has headroom but the token cap will trip before another full turn fits.`;
  }

  return [
    '## ⚠️ Final iteration — wrap up cleanly',
    headline,
    'Do not start any new long-running investigation, spawn new children, or read more files.',
    'Instead:',
    '1. Synthesize what you already know into a concise wrap-up.',
    '2. If you have enough evidence the goal is satisfied, call `goal_complete` with the proof.',
    '3. If you do not, call `goal_blocked` with the specific unblocker the user needs to provide.',
    '4. If you need more budget, say so explicitly so the user can extend it.',
  ].join('\n');
}

export interface FormatGoalBlockOptions {
  /**
   * Override the auto-detected final-budget-turn state. Useful for tests
   * and for callers that want to force-render the wrap-up directive. When
   * omitted, `formatGoalBlock` calls `goalIsOnFinalBudgetTurn(goal)` itself.
   */
  finalBudgetTurn?: boolean;
}

export function formatGoalBlock(goal: Goal, options: FormatGoalBlockOptions = {}): string {
  const cap = formatBudget(goal.budget.maxIterations);
  const remaining = cap === 'unlimited'
    ? 'unlimited'
    : String(Math.max(0, goal.budget.maxIterations - goal.budget.iterationsUsed));
  const tokenLine = goal.budget.maxTokens
    ? `**Tokens:** ${(goal.budget.tokensUsed ?? 0).toLocaleString()} of ${goal.budget.maxTokens.toLocaleString()} used`
    : '';
  const isFinalBudgetTurn = options.finalBudgetTurn ?? goalIsOnFinalBudgetTurn(goal);
  const wrapUp = isFinalBudgetTurn && goal.status === 'active' ? buildWrapUpDirective(goal) : '';
  return [
    `## Active Goal — ${goal.status.toUpperCase().replace('_', ' ')}`,
    '',
    `**Outcome:** ${goal.text}`,
    `**Iteration:** ${goal.budget.iterationsUsed + 1} of ${cap} (${remaining} remaining)`,
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
    wrapUp ? '' : '',
    wrapUp,
  ].filter(Boolean).join('\n');
}

/**
 * Drift / ready check used by the goal-continuation prompt. Compressed
 * from the prose-heavy 4-paragraph form into a 2-line checklist as part
 * of 9d's prompt deduplication — the goal text, status, and budget are
 * now owned by the goal-anchor system message; the continuation prompt
 * carries only the per-turn drift check + a pointer to the anchor.
 *
 * Distinct from `buildGoalKickoffPrompt` (in `commands/_helpers.ts`),
 * which is the FIRST-turn prompt fired by `/goal <text>` and `/goal resume`.
 */
export function buildGoalContinuationPrompt(
  goal: Goal,
  lastPrompt: string,
  lastAnswer: string,
): string {
  const iter = goal.budget.iterationsUsed + 1;
  const cap = formatBudget(goal.budget.maxIterations);
  return [
    `[GOAL CONTINUATION — iteration ${iter}/${cap}]`,
    '',
    'Your goal, budget, and the goal_complete / goal_blocked contract are pinned in the goal-anchor system message above. This turn must serve that contract.',
    '',
    '**Drift check (mandatory):**',
    '1. Does the next tool call advance the outcome stated in the anchor? If no, stop and either pick one that does, or call `goal_complete` / `goal_blocked`.',
    '2. Restating intent in prose without a tool call is anti-spin — the loop will halt on intermediate turns that emit only prose. Final goal-completing turns require prose alongside the tool call.',
    '',
    `Last user message: ${lastPrompt || '(none)'}`,
    `Your previous response (truncated): ${lastAnswer.slice(0, 600)}${lastAnswer.length > 600 ? '…' : ''}`,
  ].join('\n');
}
