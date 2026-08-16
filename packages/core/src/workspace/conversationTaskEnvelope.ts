/**
 * ADR-040 A40-2 — the bounded conversational task envelope.
 *
 * Topology selection must read more than the latest sentence and less than the
 * whole transcript. An elliptical follow-up — "now implement that", "go ahead" —
 * carries the shape of the task it refers to, not a new one; reading only the
 * current sentence loses that shape and drops the turn to `direct`. Reading the
 * whole transcript over-matches and never lets a topic end.
 *
 * So the envelope is exactly: the current message, and — only when the current
 * message is an elliptical follow-up with no task shape of its own — the last
 * unresolved user-authored task to inherit from. A message that carries its OWN
 * task is a new task (a topic change), so nothing is carried; a contextless
 * acknowledgement with nothing to inherit carries nothing and takes the direct
 * fallback. This is content- and size-bounded and reads only user-authored text
 * — assistant prose and planner output never become the shape a turn is planned
 * as.
 */

import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';

/** How many bytes of a carried task the envelope keeps — bounded, never a transcript. */
export const TASK_ENVELOPE_MAX_CARRY_CHARS = 4_000;

export interface ConversationTaskEnvelope {
  /** The current user message, verbatim. */
  currentMessage: string;
  /**
   * The last unresolved user-authored task, present ONLY when the current
   * message is an elliptical follow-up inheriting it. Provenance is always
   * user-authored text; never assistant or planner output.
   */
  carriedTask?: string;
  /**
   * The text topology signal-detection reads: the current message, plus the
   * carried task when the follow-up is elliptical. This is the one field the
   * resolver consumes.
   */
  signalText: string;
}

/**
 * An elliptical follow-up references prior work instead of stating a task. It is
 * short and opens with a continuation cue. Length-bounded so a long message that
 * merely starts with "now" is treated as its own task, not a follow-up.
 */
// CONTINUATION cues only — a message that carries the previous task forward. Pure
// acknowledgements ("ok", "yes", "thanks") are deliberately EXCLUDED: an
// acknowledgement is not a continuation, so it must not inherit a task shape (and,
// with a goal active, must not fold the goal objective) — §8.2 step 4 keeps it direct.
const ELLIPTICAL_FOLLOWUP = /^(?:\s*)(?:now|then|next|go ahead|do it|do that|continue|carry on|keep going|implement (?:that|it|this)|build (?:that|it|this)|make it so|make that change|proceed|finish (?:it|that|this)|ship it|run it|apply it)\b/i;

export function isEllipticalFollowUp(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 160) return false;
  return ELLIPTICAL_FOLLOWUP.test(trimmed);
}

export interface BuildTaskEnvelopeInput {
  currentMessage: string;
  /** True when the current message matched a topology signal on its own. */
  currentHasOwnSignals: boolean;
  /**
   * The last user-authored message that carried a topology signal, if any. The
   * caller scans a bounded window of recent USER messages for it; assistant and
   * planner text are excluded at the source.
   */
  lastUnresolvedTask?: string;
  /**
   * A goal's user-authored objective, when a goal is active. Folded in as
   * confirmed task context — treated identically to a user task, so a goal whose
   * objective equals the unresolved task selects the same plan (goal/no-goal
   * parity). The goal's EXISTENCE is never a signal; only its objective TEXT is,
   * and only the same way any user task would be.
   */
  goalObjective?: string;
}

export function buildConversationTaskEnvelope(input: BuildTaskEnvelopeInput): ConversationTaskEnvelope {
  const current = input.currentMessage;
  // Carry forward ONLY when the current message is an elliptical follow-up with
  // no task shape of its own. A message with its own signals is a new task; a
  // goal objective, when present, stands in for the unresolved task.
  const inherited = !input.currentHasOwnSignals && isEllipticalFollowUp(current)
    ? (input.lastUnresolvedTask ?? input.goalObjective)
    : undefined;
  const carriedTask = inherited ? inherited.trim().slice(0, TASK_ENVELOPE_MAX_CARRY_CHARS) : undefined;
  return {
    currentMessage: current,
    ...(carriedTask ? { carriedTask } : {}),
    signalText: carriedTask ? `${carriedTask}\n${current}` : current,
  };
}

/** How many recent user messages the envelope scans for an unresolved task. Bounded. */
export const TASK_ENVELOPE_HISTORY_WINDOW = 12;

/**
 * The last user-authored message in a bounded window that carried a topology
 * signal — the "established work shape" an elliptical follow-up refers back to.
 * `priorUserMessages` is newest-last and already excludes the current message.
 */
export function lastUnresolvedUserTask(priorUserMessages: readonly string[]): string | undefined {
  const window = priorUserMessages.slice(-TASK_ENVELOPE_HISTORY_WINDOW);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const message = window[i]!;
    if (detectOrchestrationTaskSignals(message).size > 0) return message;
  }
  return undefined;
}

/**
 * The integrated builder the live turn uses: it derives whether the current
 * message carries its own task and, if not and it is an elliptical follow-up,
 * finds the last unresolved user task (or the goal objective) to inherit.
 */
export function buildTurnTaskEnvelope(input: {
  currentMessage: string;
  /** Recent USER messages, newest last, excluding the current one. */
  priorUserMessages: readonly string[];
  goalObjective?: string;
}): ConversationTaskEnvelope {
  return buildConversationTaskEnvelope({
    currentMessage: input.currentMessage,
    currentHasOwnSignals: detectOrchestrationTaskSignals(input.currentMessage).size > 0,
    lastUnresolvedTask: lastUnresolvedUserTask(input.priorUserMessages),
    ...(input.goalObjective ? { goalObjective: input.goalObjective } : {}),
  });
}
