/**
 * Built-in extension: token-meter (ADR-041 A41-13).
 *
 * The W1 "token meter" capability, re-expressed as an extension over the D4b
 * turn-end phase hook — the first real consumer of that seam. At turn end it reads
 * the read-only usage view the turn-end context carries (session spend + the run's
 * task budget caps) and, when cumulative spend crosses a threshold of a cap, injects
 * a compact heads-up into the NEXT turn via the context's bounded write channel
 * (which rides the same pendingStopContext path stop-hooks use — never the in-flight
 * message array, per the D4 logged-context invariant).
 *
 * Today the ONLY budget signal is the hard mid-turn throw (enforceTaskBudget /
 * BudgetExceededError). This is the early warning before it: soft, model-visible,
 * and off by default of consequence (it only fires when a cap > 0 is configured).
 *
 * Plain ESM (no build step). It deep-imports the built core budget helpers under
 * `../../dist/*`; if the package isn't built, activation fails soft (the loader is
 * fault-isolated) and the agent simply has no budget advisory.
 */

import { taskUsageTokens, taskUsageUsd } from '../../dist/provider/budget.js';

const DEFAULT_THRESHOLD = 0.8;

/**
 * Given a TurnUsageView, return a compact budget-advisory line when cumulative
 * session spend has crossed `threshold` of a configured cap (but not yet the hard
 * limit — past 1.0 the enforcer has already thrown). Returns undefined when there
 * is no cap, or nothing to warn about. Pure — exported for tests.
 */
export function budgetAdvisoryFor(usage, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const caps = usage && usage.taskBudgetCaps;
  if (!caps || !usage.session) return undefined;
  const parts = [];
  if (caps.maxPerTaskTokens > 0) {
    const spent = taskUsageTokens(usage.session);
    const ratio = spent / caps.maxPerTaskTokens;
    if (ratio >= threshold && ratio < 1) {
      parts.push(
        `${Math.round(ratio * 100)}% of the ${caps.maxPerTaskTokens.toLocaleString()}-token task budget `
          + `(${spent.toLocaleString()} used)`,
      );
    }
  }
  if (caps.maxPerTaskUSD > 0) {
    const spent = taskUsageUsd(usage.model, usage.session);
    const ratio = spent / caps.maxPerTaskUSD;
    if (ratio >= threshold && ratio < 1) {
      parts.push(`${Math.round(ratio * 100)}% of the $${caps.maxPerTaskUSD} task budget ($${spent.toFixed(4)} used)`);
    }
  }
  if (!parts.length) return undefined;
  return `Budget notice: this task has used ${parts.join(' and ')}. Consider wrapping up or narrowing scope before the hard cap stops the turn.`;
}

export async function activate(host) {
  host.registerPhaseHook('turn-end', {
    after(ctx) {
      if (!ctx || !ctx.usage || typeof ctx.injectNextTurnContext !== 'function') return;
      const line = budgetAdvisoryFor(ctx.usage, { threshold: DEFAULT_THRESHOLD });
      if (line) ctx.injectNextTurnContext(line);
    },
  });
}
