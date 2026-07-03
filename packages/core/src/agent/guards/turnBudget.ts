/**
 * Adaptive per-turn tool budget (0.4.17).
 *
 * The per-turn tool-call count is NOT a task limiter — it's a runaway backstop.
 * So instead of hard-stopping the moment the agent crosses `maxToolLoops`, we
 * treat that number as a CHECKPOINT WINDOW: when the agent has made a full
 * window of tool calls without delivering a final answer, we inject a
 * self-assessment prompt that forces it to DECIDE, on its own, whether the
 * user's request is complete — and either finish or keep looping. The budget
 * extends a bounded number of times (each extension = one more window); only
 * after `MAX_BUDGET_EXTENSIONS` checkpoints does a true hard ceiling stop the
 * turn (so a genuinely stuck loop can't run forever, but a productive long task
 * is never cut off mid-flight).
 *
 * Pure helpers; the runTurn loop owns the counter + injects the checkpoint.
 */

/**
 * How many times the per-turn tool budget may be extended via a self-assessment
 * checkpoint before the hard ceiling stops the turn. The hard ceiling is
 * `window * (MAX_BUDGET_EXTENSIONS + 1)`.
 */
export const MAX_BUDGET_EXTENSIONS = 5;

export interface ToolBudget {
  /** Checkpoint window — the agent self-assesses after each `window` tool calls. */
  window: number;
  /** Absolute ceiling — the turn hard-stops here (runaway backstop). */
  hardCeiling: number;
}

/**
 * Resolve the adaptive budget from the harness `maxToolLoops` cap. The cap
 * becomes the checkpoint window (floored at 5 so tiny caps still make progress);
 * the hard ceiling is a bounded multiple of it. Pure.
 */
export function resolveToolBudget(maxToolLoops: number): ToolBudget {
  const window = Math.max(5, Math.floor(maxToolLoops) || 0);
  return { window, hardCeiling: window * (MAX_BUDGET_EXTENSIONS + 1) };
}

/**
 * True iff, at the START of iteration `loopCount` (1-based, after the counter is
 * incremented), the agent has just completed a full budget window and should be
 * made to self-assess. Fires exactly once per window boundary, and never more
 * than `MAX_BUDGET_EXTENSIONS` times. Pure.
 */
export function isBudgetCheckpoint(loopCount: number, window: number, checkpointsFired: number): boolean {
  if (checkpointsFired >= MAX_BUDGET_EXTENSIONS) return false;
  const completed = loopCount - 1;
  return completed > 0 && completed % window === 0;
}

/**
 * The self-assessment checkpoint injected as a user turn when the agent crosses
 * a budget window without finishing. It hands the continue/stop decision to the
 * model (that's the point — an adaptive loop, not a silent cutoff). Pure.
 */
export function buildBudgetCheckpoint(used: number, remaining: number): string {
  return [
    `Tool-budget checkpoint — you've made about ${used} tool calls this turn without giving a final answer yet.`,
    "Pause and decide FOR YOURSELF whether the user's request is now fully handled:",
    '- If it IS complete → write the COMPLETE final answer now, in this message, with no further tool calls.',
    `- If it is NOT complete → state in ONE short sentence what remains, then keep going. You have about ${remaining} more tool calls before a hard stop; don't repeat work you've already done, and make every call move the task forward.`,
    'Keep looping as long as you are making real progress toward answering the user — this is your call, not a forced stop.',
  ].join('\n');
}

/** The hard-ceiling message when even the extended budget is exhausted. Pure. */
export function buildBudgetCeilingMessage(hardCeiling: number): string {
  return (
    `I reached this turn's hard tool-call budget ceiling (${hardCeiling}) after ${MAX_BUDGET_EXTENSIONS} self-assessment checkpoints and still haven't finished. ` +
    'Use `/continue` to pick up where I left off (drain pending children, finish writing artifacts), ' +
    '`/agents` to see what\'s running, or raise `cli.maxToolLoops` in config.json for very heavy workflows.'
  );
}
