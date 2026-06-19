/**
 * §ADR-003 — pure goal kickoff/resume prompt builder, extracted from the CLI's
 * command helpers so the headless engine + the Desktop host can build the same
 * goal-loop prompt without importing the CLI's interactive command layer.
 */
import type { Goal } from './goalStore.js';

/** The hidden prompt that kicks off (or resumes) an autonomous `/goal` turn. */
export function buildGoalKickoffPrompt(
  goal: Goal,
  mode: 'start' | 'resume',
): string {
  const header = mode === 'start' ? '[GOAL KICKOFF — iteration 1]' : '[GOAL RESUME]';
  return [
    header,
    '',
    `Your active goal is: ${goal.text}`,
    `Iteration budget: ${goal.budget.iterationsUsed}/${goal.budget.maxIterations} used.`,
    '',
    '## What to do right now',
    mode === 'start'
      ? '1. **Open with memory.** Run `memory_search` / `memory_recall` for prior work in this workspace. Cite the recordIds you find.'
      : '1. **Reload context.** Check what was already done by reading the last few transcript entries, the current plan, and any open child agents (`list_agents`).',
    '2. **Plan briefly.** If the work has 3+ vertical slices, call `update_plan` with statuses (pending / in_progress / completed; ≤ 1 in_progress).',
    '3. **Take the first concrete tool action** toward the outcome. Read a file, write code, spawn an explorer child, run a verifier — whatever produces evidence the goal is satisfied.',
    '4. The CLI will auto-continue you with another turn after this one finishes. Iterate until you can call `goal_complete(proof)` with concrete evidence (test pass / file written / benchmark hit) or `goal_blocked(reason)` if no path remains.',
    '',
    'Do NOT respond with prose-only "I will get started" — the CLI suppresses the next auto-continuation after a turn with zero tool calls. Begin executing tools now.',
  ].join('\n');
}
