/**
 * CC-P6.2 — deliverable-contract check (0.4.15 thread B).
 *
 * A turn that DID real work (≥1 tool call) must end on the deliverable — the
 * answer, findings, or result — not on a deferral: a trailing question, an
 * offer ("let me know if you want…"), or a promise of future work ("I'll now
 * implement…"). Those endings read as helpfulness but leave the user without
 * the thing they asked for; the strongest reference agents treat "everything
 * the user needs is in the final message" as a hard contract.
 *
 * `classifyDeferral` is the pure heuristic shared in spirit with the
 * agent-behavior benchmark's premature-question / promise metrics — the guard
 * in `runTurn` fires ONE bounded corrective nudge when it matches, then
 * accepts whatever comes next (never loops). Conservative by design: only the
 * ENDING of the message is examined, so a question asked and answered mid-text
 * doesn't trip it.
 */

export type DeferralKind = 'question' | 'offer' | 'promise';

const OFFER_PHRASES: RegExp[] = [
  /let me know (if|when|what|which|whether)\b/i,
  /would you like (me|to)\b/i,
  /do you want me to\b/i,
  /shall i\b/i,
  /want me to (proceed|continue|go ahead|implement|do)\b/i,
  /just say the word\b/i,
  /happy to (do|implement|continue|dig|expand)\b/i,
];

const PROMISE_PHRASES: RegExp[] = [
  /\bi['’]ll (now |then |go ahead and )?\w+/i,
  /\bi will (now |then |go ahead and )?\w+/i,
  /\bnext,? i (will|am going to|'ll)\b/i,
  /\blet me (now )?(start|begin|implement|write|run|fix)\b/i,
  /\bgoing to (start|begin|implement|write|run|fix)\b/i,
];

/** The tail window we inspect — deferrals live at the END of a message. */
const TAIL_CHARS = 320;

/**
 * Classify how `text` ENDS. Returns the deferral kind, or null when the
 * message ends on substance. Pure.
 */
export function classifyDeferral(text: string): DeferralKind | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const tail = trimmed.slice(-TAIL_CHARS);

  // Trailing question — the message ENDS asking, not delivering. (A '?' that
  // is merely quoted/mid-tail doesn't count; we require it to close the text.)
  if (/\?\s*$/.test(trimmed)) return 'question';

  if (OFFER_PHRASES.some((re) => re.test(tail))) return 'offer';

  // Promises only count in the LAST sentence-ish chunk — "I'll check X" early
  // in the tail followed by the actual result is fine.
  const lastSentence = tail.split(/(?<=[.!])\s+/).slice(-2).join(' ');
  if (PROMISE_PHRASES.some((re) => re.test(lastSentence))) return 'promise';

  return null;
}

/** The corrective nudge injected by the runTurn guard. Pure. */
export function buildDeliverableCorrection(kind: DeferralKind, preview: string): string {
  const what =
    kind === 'question'
      ? 'ends by ASKING the user a question'
      : kind === 'offer'
        ? 'ends with an OFFER to do more ("let me know…", "would you like…")'
        : 'ends by PROMISING future work instead of doing it';
  return [
    'Runtime deliverable guardrail tripped.',
    `You did real tool work this turn, but your final message ${what}: "${preview}".`,
    'The user needs the deliverable IN THIS MESSAGE — the answer, the findings, the result of the work you just did.',
    '',
    'Do ONE of these now, in THIS response:',
    '1. **Deliver** — write the complete result of the work you already did (the answer, the diff summary, the findings with file:line references). If a follow-up offer is genuinely useful, append it AFTER the complete result.',
    '2. **Finish** — if you stopped mid-task, emit the tool_calls to finish, then deliver.',
    '3. **Blocked?** — only if you are genuinely blocked on information no tool can provide, ask ONE focused question as your entire reply.',
    '',
    'Do NOT end on a bare question, offer, or promise again.',
  ].join('\n');
}
