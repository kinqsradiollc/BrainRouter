import { readGoal } from '../../goal/store/goalStore.js';
import { buildBudgetCeilingMessage } from '../guards/turnBudget.js';

export type GoalTransition = 'complete' | 'blocked';

export interface NormalizeTurnCompletionInput {
  answer: string;
  exitedCleanly: boolean;
  maxLoops: number;
  goalTransition?: GoalTransition;
  toolCallCount: number;
  workspaceRoot: string;
  sessionKey?: string;
}

export interface NormalizedTurnCompletion {
  answer: string;
  hitLoopLimit: boolean;
}

/**
 * Resolve the user-visible answer before turn capture and lifecycle callbacks.
 *
 * This phase is intentionally limited to answer normalization. The Agent
 * facade retains ownership of capture, hook, telemetry, usage, and transcript
 * side effects so their established order cannot drift during extraction.
 */
export function normalizeTurnCompletionAnswer(
  input: NormalizeTurnCompletionInput,
): NormalizedTurnCompletion {
  if (!input.exitedCleanly) {
    return {
      answer: buildBudgetCeilingMessage(input.maxLoops),
      hitLoopLimit: true,
    };
  }

  if (input.answer.trim()) {
    return {
      answer: input.answer,
      hitLoopLimit: false,
    };
  }

  if (input.goalTransition && input.toolCallCount > 0) {
    const goal = readGoal(input.workspaceRoot, input.sessionKey);
    const evidence = goal?.blockedReason?.trim() || '(no detail recorded)';
    const action = input.goalTransition === 'complete' ? 'completed' : 'blocked';
    const field = input.goalTransition === 'complete' ? 'proof' : 'reason';
    const callSuffix = input.toolCallCount === 1 ? '' : 's';

    return {
      answer:
        `Goal ${action} after ${input.toolCallCount} tool call${callSuffix}, ` +
        `but the model skipped writing a user-visible answer in this turn.\n\n` +
        `Recorded ${field}:\n${evidence}\n\n` +
        `(If you wanted a full analysis/report, ask "summarize what you just analyzed" — the work is in memory.)`,
      hitLoopLimit: false,
    };
  }

  return {
    answer: input.toolCallCount > 0
      ? `Tool calls completed (${input.toolCallCount}) and the model returned no additional commentary.`
      : 'The model returned an empty response.',
    hitLoopLimit: false,
  };
}
