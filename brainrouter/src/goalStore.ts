import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Sticky goal for the agent: a one-line directive injected into the system
 * prompt at the start of every turn until the user explicitly clears it.
 *
 * Modeled after Claude Code's `/goal` and codex `/goal`, minus the LLM-driven
 * evaluator (we just rely on the user marking it complete). Storing this on
 * disk under `.brainrouter/cli/goal.json` survives CLI restarts.
 */

export interface Goal {
  text: string;
  setAt: string;
}

const EMPTY: Goal | null = null;

export function readGoal(workspaceRoot: string): Goal | null {
  return readJsonFile<Goal | null>(getCliStateFile(workspaceRoot, 'goal.json'), EMPTY);
}

export function setGoal(workspaceRoot: string, text: string): Goal {
  const goal: Goal = { text: text.trim(), setAt: new Date().toISOString() };
  writeJsonFile(getCliStateFile(workspaceRoot, 'goal.json'), goal);
  return goal;
}

export function clearGoal(workspaceRoot: string): void {
  writeJsonFile(getCliStateFile(workspaceRoot, 'goal.json'), null);
}

export function formatGoalBlock(goal: Goal): string {
  return [
    '## Sticky Goal (do not abandon until the user clears it)',
    `Set: ${goal.setAt}`,
    '',
    goal.text,
    '',
    'Until cleared with `/goal clear`, treat this goal as the implicit objective of every turn — even when the user asks about something else, relate the answer back to this goal when reasonable.',
  ].join('\n');
}
