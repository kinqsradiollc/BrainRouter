/**
 * ADR-061 D2/D6 — the hardening wrapper that turns any provider into a port.
 *
 * A raw provider is allowed to be imperfect: it may throw, hang, or answer with
 * something the question never admitted. None of that may reach a tool gate. So
 * every provider goes through `createDecisionPort`, which owns the four rules a
 * consumer is entitled to assume:
 *
 *  1. **A malformed question is the caller's bug**, and throws — loudly, at the
 *     call site, not as a silent wrong answer in a gate.
 *  2. **Every answer is validated** against the question that produced it
 *     ({@link validateAnswer}). An invalid answer is not an outcome; it is a
 *     fallback with the reason recorded.
 *  3. **The rules floor always stands in** — on a throw, a timeout, a missing
 *     answer, or an invalid one. `ask` does not reject for provider failure.
 *  4. **A decision never costs a System Two call.** There is no retry against
 *     a bigger model; the fallback is the rule, and it is recorded as one.
 *
 * Pure but for the clock and the injected recorder; the default provider does
 * no I/O at all.
 */

import {
  rulesAnswerFor,
  validateAnswer,
  validateQuestion,
  type DecisionAnswer,
  type DecisionAnswers,
  type DecisionPort,
  type DecisionQuestion,
  type DecisionState,
} from './types.js';

/** What a provider actually implements. May throw; may answer badly; may omit. */
export interface DecisionProvider {
  /** Stable id recorded on every answer (`rules`, `jev`, `local`). */
  readonly name: string;
  answer(
    state: DecisionState,
    questions: Record<string, DecisionQuestion>,
    signal: AbortSignal,
  ): Promise<Record<string, Pick<DecisionAnswer, 'kind' | 'value'> & Partial<DecisionAnswer>>>;
}

export interface DecisionPortOptions {
  provider?: DecisionProvider;
  /** Hard ceiling on one `ask`, after which the rules floor stands in. */
  timeoutMs?: number;
  /** Called once per answered question. Best-effort; a throw here is swallowed. */
  onDecision?: (id: string, answer: DecisionAnswer, question: DecisionQuestion) => void;
  now?: () => number;
}

/**
 * The default provider: the rule the caller already computed, at confidence 1.
 *
 * This is what makes S1 landable with nothing changed for anyone — with the
 * port on `rules`, every consumer produces exactly the outcome its heuristic
 * produced before the port existed, and `recent-decisions.json` says so.
 */
export const rulesProvider: DecisionProvider = {
  name: 'rules',
  async answer(_state, questions) {
    const out: Record<string, DecisionAnswer> = {};
    for (const [id, question] of Object.entries(questions)) out[id] = rulesAnswerFor(question);
    return out;
  },
};

/** A decision's wall-clock ceiling. Short: this tier exists to be fast. */
export const DECISION_DEFAULT_TIMEOUT_MS = 2_000;

export function createDecisionPort(options: DecisionPortOptions = {}): DecisionPort {
  const provider = options.provider ?? rulesProvider;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DECISION_DEFAULT_TIMEOUT_MS);
  const now = options.now ?? (() => Date.now());

  return {
    async ask(state: DecisionState, questions: Record<string, DecisionQuestion>): Promise<DecisionAnswers> {
      for (const [id, question] of Object.entries(questions)) {
        const bad = validateQuestion(question);
        // Rule 1: the caller's bug surfaces at the caller, not in a gate.
        if (bad) throw new Error(`Decision question "${id}" is invalid: ${bad}`);
      }
      const started = now();
      const settle = (id: string, question: DecisionQuestion, answer: DecisionAnswer): DecisionAnswer => {
        try { options.onDecision?.(id, answer, question); } catch { /* recording is best-effort */ }
        return answer;
      };
      const floorAll = (reason: string): DecisionAnswers => {
        const elapsed = now() - started;
        const out: DecisionAnswers = {};
        for (const [id, question] of Object.entries(questions)) {
          out[id] = settle(id, question, { ...rulesAnswerFor(question, elapsed), fellBack: reason });
        }
        return out;
      };

      if (provider === rulesProvider || provider.name === 'rules') {
        // No I/O, no timer, no fallback path: the floor IS the answer.
        const elapsed = now() - started;
        const out: DecisionAnswers = {};
        for (const [id, question] of Object.entries(questions)) {
          out[id] = settle(id, question, rulesAnswerFor(question, elapsed));
        }
        return out;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let raw: Awaited<ReturnType<DecisionProvider['answer']>>;
      try {
        raw = await provider.answer(state, questions, controller.signal);
      } catch (err) {
        // Rule 3 + 4: the rule decides, and nothing escalates to a big model.
        const message = err instanceof Error ? err.message : String(err);
        return floorAll(controller.signal.aborted ? `${provider.name} timed out after ${timeoutMs}ms` : `${provider.name} failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }

      const elapsed = now() - started;
      const out: DecisionAnswers = {};
      for (const [id, question] of Object.entries(questions)) {
        const candidate = raw?.[id];
        if (!candidate) {
          out[id] = settle(id, question, { ...rulesAnswerFor(question, elapsed), fellBack: `${provider.name} did not answer "${id}"` });
          continue;
        }
        // Rule 2: an answer the question never admitted is not an outcome.
        const invalid = validateAnswer(question, candidate);
        if (invalid) {
          out[id] = settle(id, question, { ...rulesAnswerFor(question, elapsed), fellBack: `${provider.name} answered invalidly — ${invalid}` });
          continue;
        }
        out[id] = settle(id, question, {
          kind: question.kind,
          value: candidate.value,
          ...(candidate.probabilities ? { probabilities: candidate.probabilities } : {}),
          ...(typeof candidate.confidence === 'number' ? { confidence: clamp01(candidate.confidence) } : {}),
          provider: provider.name,
          latencyMs: elapsed,
        });
      }
      return out;
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
