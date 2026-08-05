/**
 * ADR-028 F2/F3/F4 — the record of what the agent did and how sure it is.
 *
 * Three artifacts that answer three different questions, which is why they are
 * not one:
 *
 *   Explain (F2)      — what and why, at a depth YOU pick
 *   Decisions (F3)    — what was considered and rejected
 *   Verification (F4) — what was checked, and what was NOT
 *
 * The last is the one with no plausible downside and the strongest argument for
 * being a default. It is B1's principle applied to work product: B1 refuses to
 * claim a message was read; F4 refuses to claim work was validated when what
 * actually happened is that it compiled.
 */

/* -------------------------------------------------------------- F2 explain */

/**
 * How much explanation you asked for.
 *
 * The depth is chosen by the person, never by the agent, because an agent
 * deciding how much you need is guessing at the one thing only you know.
 */
export type ExplainDepth = 'what' | 'why' | 'teach';

export interface Explanation {
  depth: ExplainDepth;
  subject: string;
  body: string;
}

export const DEPTH_INTENT: Record<ExplainDepth, string> = {
  what: 'What changed and where — what a good diff summary already gives.',
  why: 'The decisions, and what was rejected. The diff cannot show the road not taken.',
  teach: 'The reasoning from first principles, assuming you will maintain this alone.',
};

/**
 * Should the agent offer an explanation unprompted?
 *
 * Only once, and only when the work is genuinely large. An agent that explains
 * itself after every turn is ADR-027 §1's notification failure again, and it
 * trains the reflex that makes the important explanation get skipped.
 */
export function mayOfferExplanation(input: {
  changedFiles: number;
  alreadyOffered: boolean;
}): boolean {
  if (input.alreadyOffered) return false;
  return input.changedFiles >= 8;
}

/* ------------------------------------------------------------ F3 decisions */

export interface DecisionEntry {
  id: string;
  /** What was decided. */
  chose: string;
  /**
   * What was NOT chosen, and why.
   *
   * The whole value. "We did X" is recoverable from the diff; "we considered Y
   * and rejected it because Z" is not, and it is exactly what the next person
   * needs on the day Z stops being true.
   */
  rejected: string;
  because: string;
  at: string;
  /** Where in the work this decision lives. */
  reference?: string;
}

/**
 * Is this worth recording?
 *
 * A log of obvious decisions is noise that buries the two that mattered. The
 * test is whether a reasonable person could have chosen otherwise — if not,
 * it is not a decision, it is just what happened.
 */
export function isWorthRecording(entry: Pick<DecisionEntry, 'rejected' | 'because'>): boolean {
  const rejected = entry.rejected?.trim() ?? '';
  const because = entry.because?.trim() ?? '';
  if (rejected.length < 5 || because.length < 10) return false;
  // "nothing" / "no alternative" means there was no decision to record.
  return !/^(none|nothing|n\/a|no alternative)$/i.test(rejected);
}

/**
 * Decisions must be recorded WHEN MADE, never reconstructed afterwards.
 *
 * A log written at the end is a rationalisation of what happened rather than a
 * record of what was decided — the alternatives that were genuinely considered
 * and dropped are exactly the ones you forget by then.
 */
export function isReconstructed(entry: DecisionEntry, workFinishedAt: string): boolean {
  return Date.parse(entry.at) >= Date.parse(workFinishedAt);
}

/* --------------------------------------------------------- F4 verification */

export type CheckMethod = 'test' | 'typecheck' | 'ran_it' | 'screenshot' | 'read_it';

export interface VerifiedClaim {
  claim: string;
  method: CheckMethod;
  /** The actual evidence — a test name, a command, an image path. */
  evidence: string;
}

export interface UnverifiedClaim {
  claim: string;
  /** Why it was not checked. "I forgot" is a legitimate and useful answer. */
  why: string;
}

export interface VerificationHandoff {
  verified: VerifiedClaim[];
  unverified: UnverifiedClaim[];
  /**
   * The specific thing a human should look at, chosen because the agent
   * CANNOT check it. Not a summary — a pointer.
   */
  lookAt: string | null;
}

/**
 * Is this hand-off honest?
 *
 * A hand-off claiming everything was verified and nothing was left is almost
 * always false, and the failure is invisible: it reads like thoroughness. The
 * check is deliberately blunt — if nothing is listed as unverified, say why
 * that is credible.
 */
export function validateHandoff(handoff: VerificationHandoff): string | null {
  for (const v of handoff.verified) {
    if (!v.evidence?.trim()) {
      // A claim of verification with no evidence is the exact substitution B1
      // refuses for receipts.
      return `"${v.claim}" claims to be verified but names no evidence.`;
    }
  }
  for (const u of handoff.unverified) {
    if (!u.why?.trim()) return `"${u.claim}" is unverified with no reason given.`;
  }
  if (handoff.unverified.length === 0 && handoff.verified.length > 0 && !handoff.lookAt) {
    return 'Nothing is listed as unverified and nothing is flagged to look at. That is rarely true — say what you could not check.';
  }
  return null;
}

/**
 * The one line the panel leads with.
 *
 * Leads with what was NOT checked, because that is the part that changes what
 * the reader does next. Leading with the verified count reads as reassurance,
 * and reassurance is what this artifact exists to withhold.
 */
export function describeHandoff(handoff: VerificationHandoff): string {
  if (handoff.unverified.length === 0) {
    return `${handoff.verified.length} checked, nothing left unverified.`;
  }
  const n = handoff.unverified.length;
  const lead = `${n} thing${n === 1 ? '' : 's'} I could not check`;
  return handoff.lookAt ? `${lead}. Start with: ${handoff.lookAt}` : `${lead}.`;
}

/** How a verified claim is phrased — the method, never "done" or "works". */
export const METHOD_PHRASE: Record<CheckMethod, string> = {
  test: 'a test covers it',
  typecheck: 'it typechecks',
  ran_it: 'I ran it',
  screenshot: 'I looked at it',
  read_it: 'I read it — no stronger claim than that',
};
