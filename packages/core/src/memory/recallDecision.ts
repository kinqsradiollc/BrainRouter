/**
 * ADR-061 D3.2 — the recall gate, above its rule floor.
 *
 * `decideMemoryBriefing` fires a briefing when any of a dozen cues match: a
 * continuation word, a debug word, a file path, or two "entity-shaped" tokens —
 * which `countEntityTokens` finds by counting file paths, camelCase
 * identifiers, and **mid-sentence capitalised words**.
 *
 * That last one is a proxy, and it was measurably wrong at least once: *"tell
 * me about the current state of Orbyn"* scores ONE proper noun, under the
 * threshold of two, so a question about a repository skipped the memory that
 * was about that repository. The proxy stands in for a question a `noul`
 * answers directly — *would previously captured memory help here?* — in the
 * same few hundred milliseconds the regexes take.
 *
 * The floor is untouched. Every rule that fires still fires; this is consulted
 * only on `hint-only`, the outcome that means *no cue matched and the turn was
 * not obviously social* — exactly the band the rules cannot reach. Because the
 * rules did not fire, `rulesAnswer` is 0, so the default provider yields 0, so
 * the gate stays `hint-only`: byte-for-byte what it did before.
 */

import type { DecisionPort, DecisionState } from '../decision/types.js';
import type { DecisionAnswer } from '../decision/types.js';
import type { BriefingDecision } from './briefingTriggers.js';

/** At or above this, the turn is worth a briefing. */
export const RECALL_DEFAULT_THRESHOLD = 0.6;

const QUESTION_ID = 'helpful';

const INSTRUCTIONS =
  'Would previously captured memory about this project help answer this message? '
  + 'It helps when the message asks about the state, history, or decisions of something '
  + 'specific — a project, a file, a bug, a person. It does not help for a greeting, an '
  + 'acknowledgement, a general knowledge question, or a self-contained instruction that '
  + 'names nothing to look up.';

export interface RecallDecisionResult {
  /** The decision after the tier had its say. Identical to the input on `rules`. */
  decision: BriefingDecision;
  /** The answer, when the tier was consulted at all. */
  answer?: DecisionAnswer;
  /** The band, for the record. */
  threshold?: string;
}

/** What the provider sees: the message, bounded. Redaction is the caller's. */
export function recallDecisionState(prompt: string, maxChars: number): DecisionState {
  const limit = Math.max(80, Math.floor(maxChars * 0.9));
  return { message: prompt.length > limit ? `${prompt.slice(0, limit)}…` : prompt };
}

/**
 * Ask whether a turn the rules did not flag is worth a briefing.
 *
 * Never throws, and never DOWNGRADES: a `fire` the rules produced stays a
 * `fire` whatever the tier thinks. The tier can only add a briefing the rules
 * would have missed, never remove one they asked for.
 */
export async function decideRecallWithPort(
  port: DecisionPort,
  decision: BriefingDecision,
  options: { threshold?: number; maxStateChars?: number } = {},
): Promise<RecallDecisionResult> {
  // Only the band the rules left undecided. `fire` and `skip` are theirs.
  if (decision.action !== 'hint-only') return { decision };

  const threshold = normalizeThreshold(options.threshold);
  const answers = await port.ask(
    recallDecisionState(decision.query, options.maxStateChars ?? 8_000),
    {
      [QUESTION_ID]: {
        kind: 'noul',
        instructions: INSTRUCTIONS,
        // No cue matched; that IS the floor's answer.
        rulesAnswer: 0,
      },
    },
  );
  const answer = answers[QUESTION_ID]!;
  const probability = typeof answer.value === 'number' ? answer.value : 0;

  if (probability >= threshold) {
    return {
      decision: {
        ...decision,
        action: 'fire',
        reasons: [`memory looks relevant here (${probability.toFixed(2)}), though no cue matched`],
      },
      answer,
      threshold: `>= ${threshold}`,
    };
  }
  return { decision, answer, threshold: `< ${threshold}` };
}

function normalizeThreshold(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : RECALL_DEFAULT_THRESHOLD;
}
