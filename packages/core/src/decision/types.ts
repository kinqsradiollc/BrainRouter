/**
 * ADR-061 D1 — the System One tier: one port, three primitives, no text.
 *
 * Between "a rule said so" and "ask the expensive model" there is a third rung:
 * a fast, calibrated, typed answer. A census of the loop found ten decision
 * sites — which model, is this command safe, would memory help, is the task
 * done — of which nine were rules and one asked the working model to grade
 * itself. None could say *"unsure, ask"*.
 *
 * The port is the decision; which model answers it is a provider choice, like
 * everything else here. Two properties make it safe to wire into a gate:
 *
 *  - **It cannot be creative.** A `choice` returns one of the keys it was
 *    handed; a `score`, one of the levels; a `noul`, a number in [0,1].
 *    {@link validateAnswer} enforces that on the way back from ANY provider, so
 *    a provider that invents a value is a rejected answer, not a new outcome.
 *  - **It always has a floor.** Every question carries the deterministic
 *    `rulesAnswer` its caller already computes. The default provider returns
 *    exactly that (D2), so the tier lands before any model does and the loop
 *    behaves byte-for-byte as it did until a knob changes.
 *
 * Pure: types plus validation. No I/O, no provider, browser-safe.
 */

export type DecisionKind = 'noul' | 'choice' | 'score';

/**
 * What the question is about. Text, a structured record, or a bounded slice of
 * the turn's messages — the three shapes a decision is ever asked over.
 *
 * Whatever a caller passes, it is REDACTED and size-bounded before a provider
 * that leaves this machine sees it (D4). This type is the shape, not the
 * permission.
 */
export type DecisionState =
  | string
  | Record<string, unknown>
  | ReadonlyArray<{ role: string; content: string }>;

interface QuestionBase {
  /** What is being asked, in one sentence, as the provider will read it. */
  instructions: string;
}

export interface NoulQuestion extends QuestionBase {
  kind: 'noul';
  /** The deterministic answer the caller's existing rule produces, in [0,1]. */
  rulesAnswer: number;
}

export interface ChoiceQuestion extends QuestionBase {
  kind: 'choice';
  /** Option key → the criteria that select it. At least one; at most 255 (D1). */
  options: Record<string, string>;
  /** The option the caller's existing rule picks. Must be one of `options`. */
  rulesAnswer: string;
}

export interface ScoreQuestion extends QuestionBase {
  kind: 'score';
  /** Ordered levels, lowest first (e.g. `['none','some','substantial']`). */
  levels: readonly string[];
  /** The level the caller's existing rule picks. Must be one of `levels`. */
  rulesAnswer: string;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionAnswer {
  kind: DecisionKind;
  /** A probability in [0,1] for `noul`; the chosen key or level otherwise. */
  value: number | string;
  /** Per-option distribution, when the provider states one. */
  probabilities?: Record<string, number>;
  /** How sure the provider is, in [0,1]. Absent when it cannot say (D7). */
  confidence?: number;
  /** Which provider answered — `rules` when nothing else did. */
  provider: string;
  latencyMs: number;
  /**
   * Set when the configured provider failed or answered invalidly and the
   * rules answer stood in. Carries the reason, so a silent degradation is
   * impossible to confuse with a real answer.
   */
  fellBack?: string;
}

export type DecisionAnswers = Record<string, DecisionAnswer>;

export interface DecisionPort {
  /**
   * Answer every question about one state. Questions are independent and a
   * provider may answer them in parallel; the caller gets all of them or, for
   * any that could not be answered, the rules floor with `fellBack` set.
   *
   * Never throws for a provider-side failure — a decision that cannot be made
   * is the rule's decision, not an exception in a tool gate.
   */
  ask(state: DecisionState, questions: Record<string, DecisionQuestion>): Promise<DecisionAnswers>;
}

/** D1 — a `choice` may not exceed this; beyond it the question is the wrong shape. */
export const MAX_CHOICE_OPTIONS = 255;

/** The answer a question's own rule already gives, as a full {@link DecisionAnswer}. */
export function rulesAnswerFor(question: DecisionQuestion, latencyMs = 0): DecisionAnswer {
  return {
    kind: question.kind,
    value: question.rulesAnswer,
    // A rule is certain by construction: it did not weigh anything.
    confidence: 1,
    provider: 'rules',
    latencyMs,
  };
}

/**
 * Is this answer one the question actually admits?
 *
 * The check a provider cannot talk its way past. Returns the reason it is
 * invalid, or null when it stands.
 */
export function validateAnswer(question: DecisionQuestion, answer: Pick<DecisionAnswer, 'kind' | 'value'>): string | null {
  if (answer.kind !== question.kind) return `answered as ${answer.kind}, asked as ${question.kind}`;
  if (question.kind === 'noul') {
    if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) return 'noul needs a number';
    if (answer.value < 0 || answer.value > 1) return `noul ${answer.value} is outside [0,1]`;
    return null;
  }
  if (typeof answer.value !== 'string') return `${question.kind} needs one of its own keys, got a ${typeof answer.value}`;
  const admitted = question.kind === 'choice' ? Object.keys(question.options) : [...question.levels];
  if (!admitted.includes(answer.value)) {
    return `"${answer.value}" is not one of: ${admitted.join(', ')}`;
  }
  return null;
}

/** Is this question well-formed? Returns the reason it is not, or null. */
export function validateQuestion(question: DecisionQuestion): string | null {
  if (!question.instructions.trim()) return 'a question needs instructions';
  if (question.kind === 'choice') {
    const keys = Object.keys(question.options);
    if (keys.length === 0) return 'a choice needs at least one option';
    if (keys.length > MAX_CHOICE_OPTIONS) return `a choice may have at most ${MAX_CHOICE_OPTIONS} options, got ${keys.length}`;
  }
  if (question.kind === 'score' && question.levels.length < 2) {
    return 'a score needs at least two ordered levels';
  }
  // The floor has to be a legal answer, or there is nothing to fall back to.
  const floor = validateAnswer(question, { kind: question.kind, value: question.rulesAnswer });
  return floor ? `rulesAnswer invalid: ${floor}` : null;
}
