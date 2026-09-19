/**
 * ADR-061 D3.4 — the checkpoint stops asking the stuck model whether it is stuck.
 *
 * `buildBudgetCheckpoint` hands the continue/stop decision to the model, which
 * is right in principle — an adaptive loop, not a silent cutoff — and is the
 * least reliable reading available at exactly the moment it matters. A session
 * that read the same three files forty-three times (#1724) was asked three
 * times whether it was making progress and said yes three times. Meanwhile the
 * runtime had already recorded the denial driving the loop, in
 * `recent-denials.json`, and nothing put the two together.
 *
 * So: score the window's own tool results — from outside the loop — and when
 * the answer is `none`, say so plainly AND hand over the denials the runtime
 * recorded. The model is told what is actually blocking it instead of being
 * asked to introspect.
 *
 * The rules have no opinion here; their `rulesAnswer` is `some`, which routes
 * to the existing self-assessment prompt unchanged.
 */

import type { DecisionAnswer, DecisionPort, DecisionState } from '../../decision/types.js';

export type ProgressLevel = 'none' | 'some' | 'substantial';

export const PROGRESS_LEVELS: readonly ProgressLevel[] = ['none', 'some', 'substantial'];

const QUESTION_ID = 'progress';

const INSTRUCTIONS =
  'How much progress did these tool calls make toward the task? '
  + '"none" means the calls repeated earlier work, returned the same content again, or all '
  + 'failed the same way — the loop is not advancing. "some" means partial progress with '
  + 'detours. "substantial" means the calls moved the task forward.';

/** One tool call as the scorer sees it: what ran, and what came back. */
export interface ProgressToolCall {
  name: string;
  /** The result, already truncated by the caller. */
  result: string;
  isError?: boolean;
}

export interface ProgressDecisionResult {
  level: ProgressLevel;
  answer: DecisionAnswer;
  threshold: string;
}

/**
 * What the provider sees. Names, error flags, and a short head of each result —
 * enough to tell repetition from progress, and far short of the window itself.
 */
export function progressDecisionState(calls: readonly ProgressToolCall[], maxChars: number): DecisionState {
  const perCall = Math.max(60, Math.floor(maxChars / Math.max(1, calls.length)) - 40);
  return {
    calls: calls.map((call) => ({
      tool: call.name,
      ...(call.isError ? { failed: true } : {}),
      result: call.result.length > perCall ? `${call.result.slice(0, perCall)}…` : call.result,
    })),
  };
}

/** Score the window. Never throws; the rules floor is `some`. */
export async function decideTurnProgress(
  port: DecisionPort,
  calls: readonly ProgressToolCall[],
  options: { maxStateChars?: number } = {},
): Promise<ProgressDecisionResult> {
  const answers = await port.ask(
    progressDecisionState(calls, options.maxStateChars ?? 8_000),
    {
      [QUESTION_ID]: {
        kind: 'score',
        instructions: INSTRUCTIONS,
        levels: PROGRESS_LEVELS,
        // The rules cannot tell; `some` is the reading that changes nothing.
        rulesAnswer: 'some',
      },
    },
  );
  const answer = answers[QUESTION_ID]!;
  const level = (PROGRESS_LEVELS as readonly string[]).includes(String(answer.value))
    ? (answer.value as ProgressLevel)
    : 'some';
  return { level, answer, threshold: `level=${level}` };
}

/**
 * The checkpoint for a window that went nowhere.
 *
 * Deliberately not a question. The model has already answered the question
 * wrongly, by looping; what it is missing is the evidence, so this states the
 * finding and hands over what the runtime recorded. `denials` are the last few
 * entries from `recent-denials.json` — the sentence that would have ended the
 * session in #1724 an hour earlier.
 */
export function buildNoProgressCheckpoint(
  used: number,
  remaining: number,
  denials: readonly string[],
): string {
  const lines = [
    `Tool-budget checkpoint — you've made about ${used} tool calls this turn and the last window made NO progress:`,
    'the calls repeated earlier work, returned the same content again, or failed the same way.',
  ];
  if (denials.length > 0) {
    lines.push(
      '',
      'This is what the runtime refused during this session — it is very likely what is actually blocking you:',
      ...denials.slice(0, 5).map((d) => `  · ${d}`),
      '',
      'If one of those is in your way, STOP retrying it and either work around it or say you are blocked.',
    );
  }
  lines.push(
    '',
    `Do not repeat a call you have already made. You have about ${remaining} tool calls left.`,
    'Either take a genuinely different action, write the answer you can give with what you already have,',
    'or call `goal_blocked` with what you need — those are the three options.',
  );
  return lines.join('\n');
}
