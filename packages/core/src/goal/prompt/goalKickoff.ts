/**
 * §ADR-003 — pure goal kickoff/resume prompt builder, extracted from the CLI's
 * command helpers so the headless engine + the Desktop host can build the same
 * goal-loop prompt without importing the CLI's interactive command layer.
 */
import type { Goal } from '../store/goalStore.js';

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
    'Work this goal the way a strong engineer works a ticket: plan, then build it',
    'yourself in small verified steps. You are the implementer — not a dispatcher.',
    '',
    '## What to do right now',
    mode === 'start'
      ? '1. **Open with memory + survey.** Run `memory_search` / `memory_recall` for prior work (cite recordIds), then read the workspace to ground yourself (list files, read the key entry points / config).'
      : '1. **Reload context.** Read the last few transcript entries, the current plan, and any open child agents (`list_agents`) to see what is already done.',
    '2. **Always plan.** Call `update_plan` to break the goal into ordered steps (pending / in_progress / completed; ≤ 1 in_progress). A starter plan item is already shown — replace it with the real breakdown. Keep it updated as you go.',
    '3. **Implement it YOURSELF, incrementally.** Make the smallest next change with direct tools (`read_file`, `write_file`, `edit_file`, `run_command`), then verify it (build / typecheck / test) before the next step. Land one working vertical slice at a time.',
    '4. **Parallelize only genuinely independent work.** Spawn child agents (`task_agent`) ONLY for chunks that are truly independent and can run at the same time (e.g. several unrelated modules). For a single cohesive task, do it directly — do NOT kick off a `run_workflow` build/verify pipeline for routine steps (that just burns turns and nests work you can do inline).',
    '5. The loop auto-continues you with another turn after this one. Iterate until you can call `goal_complete(proof)` with concrete evidence (tests pass / files written / build green) or `goal_blocked(reason)` if no path remains.',
    '',
    'Do NOT respond with prose-only "I will get started" — the loop suppresses the next auto-continuation after a turn with zero tool calls. Plan, then start executing tools now.',
  ].join('\n');
}
