import {
  addGoalTokens,
  buildGoalContinuationPrompt,
  formatBudget,
  goalHasBudgetLeft,
  readGoal,
  tickGoalIteration,
  usageLimitGoal,
} from '@kinqs/brainrouter-core/goal';
import type { RunChatContext } from './context.js';

/**
 * Goal continuation. After each turn ends successfully, schedule the next
 * continuation iff the goal is still active and made progress. The user's
 * next keystroke cancels the queued continuation.
 */
export function installGoalContinuation(ctx: RunChatContext): void {
  const { agent } = ctx;

  ctx.scheduleGoalContinuation = (afterPrompt: string, afterAnswer: string) => {
    let goalAfter = readGoal(agent.workspaceRoot, agent.sessionKey);
    if (goalAfter && goalAfter.budget.maxTokens) {
      const delta = (agent.lastTurnUsage?.promptTokens ?? 0) + (agent.lastTurnUsage?.completionTokens ?? 0);
      if (delta > 0) {
        const updated = addGoalTokens(agent.workspaceRoot, agent.sessionKey, delta);
        if (updated) goalAfter = updated;
      }
      if (
        goalAfter &&
        goalAfter.status === 'active' &&
        typeof goalAfter.budget.maxTokens === 'number' &&
        (goalAfter.budget.tokensUsed ?? 0) >= goalAfter.budget.maxTokens
      ) {
        const limited = usageLimitGoal(
          agent.workspaceRoot,
          agent.sessionKey,
          `Token budget reached: ${(goalAfter.budget.tokensUsed ?? 0).toLocaleString()} of ${goalAfter.budget.maxTokens.toLocaleString()} used.`,
        );
        if (limited) goalAfter = limited;
      }
    }

    // Reset the strike counter the moment the model actually emits tool calls.
    if (agent.lastTurnToolCalls > 0) ctx.goalNoToolStrikes = 0;

    const goalActive = !!goalAfter && goalAfter.status === 'active' && goalHasBudgetLeft(goalAfter) && agent.lastGoalTransition === undefined;
    const correctiveAvailable = goalActive && agent.lastTurnToolCalls === 0 && ctx.goalNoToolStrikes < 1;

    const shouldContinue =
      goalActive &&
      (agent.lastTurnToolCalls > 0 || correctiveAvailable);

    if (goalAfter && goalAfter.status === 'complete') {
      ctx.controller?.push.notice(`🎯 Goal achieved — ${goalAfter.blockedReason ?? 'evidence on record.'}`, 'info');
    } else if (goalAfter && goalAfter.status === 'blocked') {
      ctx.controller?.push.notice(`🚧 Goal blocked: ${goalAfter.blockedReason ?? '(no reason)'}`, 'warn');
      ctx.controller?.push.notice(`Resolve the blocker, then /goal resume to continue.`, 'info');
    } else if (goalAfter && goalAfter.status === 'usage_limited') {
      ctx.controller?.push.notice(`⏸ Goal hit usage limit: ${goalAfter.blockedReason ?? 'budget exhausted'}.`, 'warn');
      ctx.controller?.push.notice(`Raise the cap with /goal budget <n> or /goal tokens <n>, then /goal resume.`, 'info');
    } else if (goalAfter && goalAfter.status === 'active' && !goalHasBudgetLeft(goalAfter)) {
      const reason = `Iteration budget exhausted (${goalAfter.budget.iterationsUsed}/${formatBudget(goalAfter.budget.maxIterations)}).`;
      const limited = usageLimitGoal(agent.workspaceRoot, agent.sessionKey, reason);
      ctx.controller?.push.notice(`⏸ ${reason} Extend with /goal budget <n> and /goal resume, mark /goal complete, or /goal clear.`, 'warn');
      if (limited) goalAfter = limited;
    } else if (goalAfter && goalAfter.status === 'active' && agent.lastTurnToolCalls === 0 && !correctiveAvailable) {
      ctx.controller?.push.notice(`(goal continuation halted: two prose-only turns in a row — type a message or /goal clear to continue)`, 'warn');
    } else if (correctiveAvailable) {
      ctx.controller?.push.notice(`(prose-only turn — sending one corrective retry; emit tool calls or call goal_blocked)`, 'info');
    }

    if (shouldContinue && goalAfter) {
      ctx.pendingContinuation = true;
      const next = goalAfter.budget.iterationsUsed + 1;
      if (correctiveAvailable) ctx.goalNoToolStrikes += 1;
      ctx.controller?.push.notice(`(goal continuation queued — iteration ${next}/${formatBudget(goalAfter.budget.maxIterations)}; type anything to cancel)`, 'info');
      const baseFollowUp = buildGoalContinuationPrompt(goalAfter, afterPrompt, afterAnswer);
      const followUp = correctiveAvailable
        ? `${baseFollowUp}\n\n**CORRECTIVE NOTICE:** your previous turn emitted zero tool calls — that violates the goal contract. THIS turn MUST emit at least one tool call (start exploration with parallel \`list_dir\` + \`glob_files\` + \`read_file\` of AGENT.md/README.md in a single message) OR call \`goal_blocked\` with a concrete reason. Prose-only is not an option.`
        : baseFollowUp;
      setImmediate(() => {
        if (!ctx.pendingContinuation || ctx.isProcessing) return;
        ctx.pendingContinuation = false;
        tickGoalIteration(agent.workspaceRoot, agent.sessionKey);
        void ctx.runChatTurn(followUp);
      });
    }
  };
}
