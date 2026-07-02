import type { Goal } from './goalModel.js';
import { formatBudget } from './goalModel.js';
import { goalHasBudgetLeft } from './goalBudget.js';

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
/**
 * GOAL CONTINUATION DECISION (shared by the CLI Ink loop AND the desktop host),
 * so `/goal` auto-continuation behaves identically on both heads. Pure: given
 * the goal + the just-finished turn's signals, decide what happens next. The
 * caller owns the side effects (ticking the iteration, transitioning the goal,
 * firing the next turn) so this stays testable.
 */
export interface GoalContinuationSignals {
  /** Tool calls the just-finished turn made (0 → prose-only / anti-spin). */
  lastTurnToolCalls: number;
  /** Set when the model called goal_complete / goal_blocked this turn. */
  lastGoalTransition: 'complete' | 'blocked' | undefined;
  /** Consecutive prose-only "strikes" already spent this goal run. */
  noToolStrikes: number;
}

export type GoalContinuationDecision =
  | { kind: 'continue'; corrective: boolean; nextIteration: number }
  | { kind: 'halt-prose' }                       // two prose-only turns in a row
  | { kind: 'usage-limited'; reason: string }    // iteration or token budget exhausted
  | { kind: 'stop' };                            // not active / paused / goal_complete-or-blocked fired

/**
 * Decide whether the goal loop fires another turn. Mirrors the CLI Ink loop:
 *  - not active, or goal_complete/goal_blocked fired this turn → stop.
 *  - token or iteration budget exhausted → usage-limited (caller marks it).
 *  - the turn made ≥1 tool call → continue.
 *  - prose-only turn, first strike → continue with a CORRECTIVE nudge.
 *  - prose-only turn, second strike → halt-prose.
 */
export function decideGoalContinuation(
  goal: Goal | null,
  signals: GoalContinuationSignals,
): GoalContinuationDecision {
  if (!goal || goal.status !== 'active') return { kind: 'stop' };
  if (signals.lastGoalTransition !== undefined) return { kind: 'stop' };
  if (
    typeof goal.budget.maxTokens === 'number' &&
    goal.budget.maxTokens > 0 &&
    (goal.budget.tokensUsed ?? 0) >= goal.budget.maxTokens
  ) {
    return { kind: 'usage-limited', reason: `Token budget reached: ${(goal.budget.tokensUsed ?? 0).toLocaleString()} of ${goal.budget.maxTokens.toLocaleString()} used.` };
  }
  if (!goalHasBudgetLeft(goal)) {
    return { kind: 'usage-limited', reason: `Iteration budget exhausted (${goal.budget.iterationsUsed}/${formatBudget(goal.budget.maxIterations)}).` };
  }
  if (signals.lastTurnToolCalls > 0) return { kind: 'continue', corrective: false, nextIteration: goal.budget.iterationsUsed + 1 };
  if (signals.noToolStrikes < 1) return { kind: 'continue', corrective: true, nextIteration: goal.budget.iterationsUsed + 1 };
  return { kind: 'halt-prose' };
}

/** The corrective suffix appended to a continuation prompt after a prose-only turn. */
export function goalCorrectiveNotice(): string {
  return '**CORRECTIVE NOTICE:** your previous turn emitted zero tool calls — that violates the goal contract. THIS turn MUST emit at least one tool call OR call `goal_blocked` with a concrete reason. Prose-only is not an option.';
}

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
