/**
 * ADR-032 D2 — the gate. Nothing is learned by default.
 *
 * This is the decision that keeps the store from becoming noise, so the bar is
 * STATED here rather than vibed inside a prompt where nobody can test it. Every
 * rule below rejects with a named reason, and every reason is something a
 * person can disagree with out loud.
 *
 * The requirement that is ours rather than borrowed:
 *
 * > **A candidate lesson must name what would show it wrong.**
 *
 * "Prefer `rg` over `grep`" is admissible — it fails visibly the day `rg` is
 * absent. "Be more careful" is not: nothing could ever contradict it, so it
 * could never be retired, and an unfalsifiable lesson is a permanent resident.
 * D6 can only demote what something is able to check.
 *
 * Pure and DB-free on purpose. The gate is the part most likely to be argued
 * with, and an argument you can settle with a unit test is a short one.
 */
import type {
  LearnedForm, LearnedOrigin, LearnedTier,
} from './types.js';

/** What the reflector proposes, before anything decides whether to keep it. */
export interface LearningCandidate {
  readonly form: LearnedForm;
  readonly statement: string;
  readonly falsifier: string;
  readonly expectation: string;
  /** Trajectory lines supporting it. Empty means unsupported (D2). */
  readonly evidence: readonly string[];
  readonly origin: LearnedOrigin;
  /**
   * How many times the pattern showed up in the window under review. §6's test
   * is a mistake repeated three times; once is an anecdote.
   */
  readonly occurrences: number;
  /** D7 — was attacker-influenced content in the window? */
  readonly sawUntrustedContent: boolean;
  /** D7 — did something the agent or the person DID corroborate it? */
  readonly corroboratedByTrustedAction: boolean;
  /** Runtime-issued ids for successful post-read actions relevant to THIS
   * candidate. Empty for untrusted content means the global session action
   * tally cannot accidentally admit it. */
  readonly corroboratingActionIds?: readonly string[];
  /** What tier the candidate asks for. The gate may refuse or downgrade it. */
  readonly requestedTier: LearnedTier;
  /** Ordered executable steps. Required for procedure-shaped candidates. */
  readonly steps?: readonly string[];
}

export type GateRule =
  | 'malformed'
  | 'unfalsifiable'
  | 'exhortation'
  | 'unsupported'
  | 'transient'
  | 'one-off'
  | 'untrusted-only'
  | 'non-executable';

export type GateVerdict =
  | {
    readonly admitted: true;
    readonly tier: LearnedTier;
    /** Set when the requested tier was refused but the item still got in. */
    readonly downgradedFrom?: LearnedTier;
    readonly reasoning: string;
  }
  | { readonly admitted: false; readonly rule: GateRule; readonly reason: string };

/** A statement shorter than this says nothing a future session can act on. */
export const MIN_STATEMENT_CHARS = 12;
/** A falsifier shorter than this is a gesture at a check, not a check. */
export const MIN_FALSIFIER_CHARS = 10;
/** Long enough for a rule, short enough that it is a rule and not a document. */
export const MAX_STATEMENT_CHARS = 400;
/** Central learned projections keep each retirement check bounded. */
export const MAX_FALSIFIER_CHARS = 400;
/** Expected outcomes share the same bounded projection contract. */
export const MAX_EXPECTATION_CHARS = 400;

/**
 * Statements that cannot be wrong, and therefore cannot be retired.
 *
 * These are the shapes a reflective model reaches for when a session went badly
 * and there is nothing concrete to say — which is exactly the session most
 * likely to trigger a checkpoint (§1's worst gap). Left in, they accumulate
 * forever and dilute everything that IS checkable.
 */
const EXHORTATION_PATTERNS: readonly RegExp[] = [
  /^(?:always |never |try to |remember to )?(?:be|stay|remain|get|act) (?:more |less )?\w+\.?$/i,
  /\b(?:be|being) (?:more|less) (?:careful|cautious|thorough|diligent|attentive|mindful|rigorous|patient|efficient)\b/i,
  /\b(?:pay|paying) (?:more )?attention\b/i,
  /\b(?:think|thinking) (?:more|harder|carefully)\b/i,
  /\b(?:do|does|doing) (?:a )?better(?: job)?\b/i,
  /\btry harder\b/i,
  /\bavoid (?:mistakes|errors|problems|issues)\b/i,
  /\b(?:double[- ]?check|verify) (?:everything|things|stuff)\b/i,
];

/**
 * The ways of saying nothing, enumerated — and the reason this is a REJECTION
 * set rather than an acceptance one.
 *
 * The first version of this rule required the falsifier to contain a verb from
 * a list of "observation words". That is the wrong polarity: the ways to name a
 * real observation are open-ended ("the release history still matches origin",
 * "the reviewer approves it unchanged"), so an acceptance list rejects perfectly
 * good falsifiers and the store learns nothing — which ADR-029 F1 rates worse
 * than the noise D2 is trying to avoid. The ways to say nothing, by contrast,
 * are a small closed set of placeholders, and those are what this catches.
 */
const VACUOUS_FALSIFIERS: readonly RegExp[] = [
  /^(?:n\/?a|none|nothing|unknown|unclear|tbd|-+)\.?$/i,
  /\b(?:something|anything|things?) (?:goes? wrong|breaks?|fails?|happens?)\b/i,
  /\bit turns out\b/i,
  /^(?:if )?(?:it|this|that|the (?:claim|lesson|rule|statement))\b[^.]*\b(?:wrong|incorrect|false|not true|does ?n[o']t (?:work|help|apply))\b/i,
  /^(?:it|this|that) (?:fails?|breaks?|goes? wrong)\.?$/i,
];

/** Fewer words than this is a gesture at a check rather than a check. */
const MIN_FALSIFIER_WORDS = 3;

/**
 * Volatile detail that will not be true tomorrow. A "lesson" carrying a pid, a
 * port, a temp path or a commit hash is transient tool output wearing a lesson's
 * clothes: it can never be confirmed again, so it would sit at zero
 * confirmations until D6 retires it, having cost an LLM call and a slot.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(?:pid|PID)\s*[:=#]?\s*\d+/,
  /\b(?:127\.0\.0\.1|localhost)[:.]\d{2,5}\b/,
  /\bport\s+\d{2,5}\b/i,
  /\b[0-9a-f]{12,}\b/i,
  // No `\b` before the slash: a word boundary needs a word character on one
  // side, and " /tmp/" has none — the anchor that looks safest is the one that
  // silently never fires.
  /(?:^|[\s"'(=:])(?:\/tmp|\/private\/var\/folders|\/var\/folders)\//,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Review one candidate.
 *
 * Order matters and is deliberate: the cheap structural refusals run before the
 * judgement calls, so a malformed candidate is reported as malformed rather
 * than as whichever richer rule happened to fire on its empty fields.
 */
export function reviewLearningCandidate(candidate: LearningCandidate): GateVerdict {
  const statement = candidate.statement.trim();
  const falsifier = candidate.falsifier.trim();
  const expectation = candidate.expectation.trim();

  if (statement.length < MIN_STATEMENT_CHARS || statement.length > MAX_STATEMENT_CHARS) {
    return {
      admitted: false,
      rule: 'malformed',
      reason: `statement must be ${MIN_STATEMENT_CHARS}-${MAX_STATEMENT_CHARS} characters (got ${statement.length})`,
    };
  }
  if (!expectation) {
    return {
      admitted: false,
      rule: 'malformed',
      reason: 'no expected outcome — D6 cannot measure what was never predicted',
    };
  }
  if (falsifier.length > MAX_FALSIFIER_CHARS || expectation.length > MAX_EXPECTATION_CHARS) {
    return {
      admitted: false,
      rule: 'malformed',
      reason: `falsifier and expectation must each be at most ${MAX_FALSIFIER_CHARS} characters`,
    };
  }

  // D3 is an execution claim, not a prose label. Persisting an executable form
  // without an executable body creates a lesson that says it runs but never
  // can. Delegation remains closed until a dedicated runtime-owned child port
  // can prove and re-apply a narrower child authority; ordinary tool
  // corroboration is not delegation authority.
  if (candidate.form === 'delegation') {
    return {
      admitted: false,
      rule: 'non-executable',
      reason: 'delegation learning is unavailable until a constrained runtime delegation port can execute it',
    };
  }
  if (candidate.form === 'procedure') {
    const steps = candidate.steps ?? [];
    if (
      steps.length === 0
      || steps.length > 20
      || steps.some((step) => !step.trim() || step.trim().length > 240)
    ) {
      return {
        admitted: false,
        rule: 'non-executable',
        reason: 'a procedure requires 1-20 nonblank steps of at most 240 characters each',
      };
    }
  }

  // D2's own requirement, checked from both ends: the CLAIM must be the kind of
  // thing that can be wrong, and the FALSIFIER must name how we would find out.
  if (matchesAny(statement, EXHORTATION_PATTERNS)) {
    return {
      admitted: false,
      rule: 'exhortation',
      reason: 'nothing could contradict this, so it could never be retired',
    };
  }
  if (falsifier.length < MIN_FALSIFIER_CHARS) {
    return {
      admitted: false,
      rule: 'unfalsifiable',
      reason: 'no falsifier — the item must name what would show it wrong',
    };
  }
  if (falsifier.toLowerCase() === statement.toLowerCase()) {
    return {
      admitted: false,
      rule: 'unfalsifiable',
      reason: 'the falsifier restates the claim instead of naming a contrary observation',
    };
  }
  if (
    falsifier.split(/\s+/).filter(Boolean).length < MIN_FALSIFIER_WORDS
    || matchesAny(falsifier, VACUOUS_FALSIFIERS)
  ) {
    return {
      admitted: false,
      rule: 'unfalsifiable',
      reason: 'the falsifier names no observable outcome, so nothing could ever check it',
    };
  }

  const evidence = candidate.evidence.map((line) => line.trim()).filter(Boolean);
  if (evidence.length === 0) {
    return {
      admitted: false,
      rule: 'unsupported',
      reason: 'no trajectory evidence — an inference with no support is a hypothesis',
    };
  }

  if (matchesAny(`${statement}\n${falsifier}`, TRANSIENT_PATTERNS)) {
    return {
      admitted: false,
      rule: 'transient',
      reason: 'carries run-specific detail (pid / port / hash / temp path) that cannot recur',
    };
  }

  // A human correction is admissible the first time it is given; that is the
  // whole point of D1's second tier. A model inference is not — §6's test is a
  // mistake repeated, and once is an anecdote.
  if (candidate.origin !== 'human-correction' && candidate.occurrences < 2) {
    return {
      admitted: false,
      rule: 'one-off',
      reason: `seen ${candidate.occurrences}× — a single occurrence is an anecdote, not a pattern`,
    };
  }

  // D7 — the risk that does not exist in the read-only case. A PDF, a fetched
  // page or a mirrored issue title is attacker-influenced; something the agent
  // or the person actually DID has to corroborate it before it becomes
  // something the agent believes in every future session.
  if (
    candidate.sawUntrustedContent
    && (
      !candidate.corroboratedByTrustedAction
      || (candidate.corroboratingActionIds?.length ?? 0) === 0
    )
  ) {
    return {
      admitted: false,
      rule: 'untrusted-only',
      reason: 'derived solely from untrusted content with nothing the agent or the person did to corroborate it',
    };
  }

  // D1/D7 — the instruction tier is reachable ONLY by a human correction in
  // session. A downgrade rather than a refusal: the observation may well be
  // worth keeping, it simply does not get to command.
  if (candidate.requestedTier === 'instruction' && candidate.origin !== 'human-correction') {
    return {
      admitted: true,
      tier: 'evidence',
      downgradedFrom: 'instruction',
      reasoning:
        `falsifiable, supported by ${evidence.length} trajectory reference(s), seen ${candidate.occurrences}×; `
        + 'asked for the instruction tier without a human correction, so it enters as evidence',
    };
  }

  return {
    admitted: true,
    tier: candidate.requestedTier,
    reasoning:
      `falsifiable, supported by ${evidence.length} trajectory reference(s), seen ${candidate.occurrences}×`
      + (candidate.origin === 'human-correction' ? '; corrected in session by a person' : ''),
  };
}
