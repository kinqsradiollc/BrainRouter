/**
 * Shared internal helpers for the workflow slash-command handlers.
 * Split out of the original workflow/index.ts god file (behavior-preserving).
 */

import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import chalk from 'chalk';
import { formatBudget, type Goal } from '@kinqs/brainrouter-core/goal';
import { linkPlanDecision, type PlanDecision } from '@kinqs/brainrouter-core/task';
import { emitAgentEvent } from '@kinqs/brainrouter-core/memory';
import type { CommandContext } from '../_context.js';

// Promise-flavored exec for case bodies that shell out.
export const execPromise = promisify(exec);

/**
 * Strip a `--force` token from a slash command's arg list, returning the
 * flag's presence plus the rest. Used by /feature-dev / /spec / /review
 * to gate Subtask 6's clobber prompt (mirrors /grill-me's --force parsing).
 */
export function parseForceFlag(args: string[]): { force: boolean; rest: string[] } {
  return { force: args.includes('--force'), rest: args.filter((a) => a !== '--force') };
}

/**
 * Print the one-line confirmation banner after a successful `/workflow
 * switch <slug>` (or a no-op switch onto the already-current workflow).
 * Format: `Switched to workflow <slug> — goal: <status>, iteration N of cap`
 * — or `goal: —` when no goal is bound.
 */
export function printWorkflowSwitchConfirmation(slug: string, goal: Goal | null): void {
  if (!goal) {
    console.log(chalk.green(`\n✓ Switched to workflow "${slug}" — goal: —.\n`));
    return;
  }
  const statusLabel = goal.status.replace('_', ' ');
  const iter = goal.budget.iterationsUsed;
  const cap = formatBudget(goal.budget.maxIterations);
  console.log(chalk.green(
    `\n✓ Switched to workflow "${slug}" — goal: ${statusLabel}, iteration ${iter} of ${cap}.\n`,
  ));
}

/**
 * §7 — capture a plan review decision into BrainRouter memory (best-effort) and
 * link the returned memory id back onto the decision. A brain miss must never
 * break the command.
 */
export async function capturePlanDecision(ctx: CommandContext, decision: PlanDecision): Promise<void> {
  try {
    const memoryId = await emitAgentEvent(
      { mcpClient: ctx.mcpClient, sessionKey: ctx.agent.sessionKey },
      {
        kind: 'agent_output',
        summary: `Plan ${decision.verdict} (${decision.id}) — ${decision.planSnapshot.length} item(s)${decision.feedback ? `: ${decision.feedback}` : ''}`,
        payload: {
          planDecisionId: decision.id,
          verdict: decision.verdict,
          feedback: decision.feedback,
          requirementId: decision.requirementId,
          itemCount: decision.planSnapshot.length,
        },
      },
    );
    if (memoryId) linkPlanDecision(ctx.agent.workspaceRoot, ctx.agent.sessionKey, decision.id, memoryId);
  } catch {
    // advisory — never break the command
  }
}
