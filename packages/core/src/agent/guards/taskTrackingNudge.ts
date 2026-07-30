/**
 * CC-P9.2 — task-tracking nudge (0.4.15 thread E).
 *
 * BrainRouter already has a structured task tracker: `update_plan` writes a
 * per-session list of `{ step, status }` items (the full-list-rewrite model,
 * same shape as Claude Code's TodoWrite). What it lacked is Claude Code's
 * HARNESS nudge — the "task tools haven't been used / this looks like
 * multi-step work" reminder that appears when a turn does substantial work
 * WITHOUT any task tracking at all.
 *
 * This is distinct from `planSyncGuard`, which only fires when a plan already
 * EXISTS but wasn't advanced. Here the plan is empty and the turn was clearly
 * multi-step — so a one-time, per-session reminder to start tracking helps the
 * user (and the model) keep long tasks legible. Pure → tested; the runTurn
 * caller owns the once-per-session latch so it never nags.
 */

/** Tool calls in one turn at/above which untracked work warrants the nudge. */
export const TASK_NUDGE_TOOLCALL_THRESHOLD = 5;

/**
 * Should we nudge the model to start tracking tasks? True when the turn did
 * enough tool work to be "multi-step", there is NO plan yet, and we haven't
 * already nudged this session. Pure.
 */
export function shouldNudgeTaskTracking(input: {
  toolCallsThisTurn: number;
  planItemCount: number;
  alreadyNudged: boolean;
  silent: boolean;
}): boolean {
  if (input.silent) return false; // child agents don't get the harness nudge
  if (input.alreadyNudged) return false;
  if (input.planItemCount > 0) return false; // tracking already in use
  return input.toolCallsThisTurn >= TASK_NUDGE_TOOLCALL_THRESHOLD;
}

/** The reminder injected once per session. Pure. */
export function buildTaskTrackingNudge(toolCallsThisTurn: number): string {
  return [
    `Task-tracking reminder: this turn made ${toolCallsThisTurn} tool calls but no task list is being kept.`,
    'For multi-step work, call `update_plan` with an ordered list of `{ step, status }` items (exactly one `in_progress` at a time) so the user can see the plan, and mark items `completed` as you finish them.',
    'Skip this only if the task is genuinely a single step. This is a one-time reminder for this session.',
  ].join('\n');
}
