import type { Goal } from './goalModel.js';

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
