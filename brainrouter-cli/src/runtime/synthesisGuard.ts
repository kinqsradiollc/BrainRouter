/**
 * MAR-3 (0.4.13) — child-synthesis guard helpers.
 *
 * A weak model sometimes calls a child/sub-agent, RECEIVES its results inline, then
 * ends the turn with a deferral ("I've launched an agent… I'll summarize later")
 * instead of synthesizing what it already has. These pure helpers let the runTurn
 * guardrail detect that case and force ONE synthesis pass. Conservative by design:
 * the punt detector pairs a deferral phrase with a length cap so a real (longer)
 * synthesis is never flagged, and the guard is bounded to fire once.
 */

/** Tool names whose result delivers a child / sub-agent's findings to the parent. */
export function isChildSynthesisTool(name: string): boolean {
  return (
    name === 'task_agent' ||
    name === 'wait_agent' ||
    name === 'wait_agents' ||
    name.startsWith('delegate_')
  );
}

/**
 * True if a tool-result JSON actually carries child output — a non-empty
 * `finalOutput`, a parsed `contract`, or an `agents[]` entry with one. Defensive
 * parse (non-JSON / unexpected shapes → false). Pure.
 */
export function resultHasChildOutput(resultText: string): boolean {
  let obj: any;
  try {
    obj = JSON.parse(resultText);
  } catch {
    return false;
  }
  const hasOut = (o: any): boolean =>
    !!o &&
    typeof o === 'object' &&
    ((typeof o.finalOutput === 'string' && o.finalOutput.trim().length > 0) ||
      (!!o.contract && typeof o.contract === 'object'));
  if (hasOut(obj)) return true;
  if (obj && Array.isArray(obj.agents)) return obj.agents.some(hasOut);
  return false;
}

/** Deferral / "I'll do it later" phrasings used instead of synthesizing results. */
const PUNT_PATTERNS: RegExp[] = [
  /\bI(?:'| wi| wil)?ll\s+(?:summari[sz]e|report back|update you|let you know|share|notify|get back)/i,
  /\b(?:will|going to|about to)\s+(?:summari[sz]e|report|compile|share)\b/i,
  /\b(?:still|currently)\s+(?:working|running|analy[sz]ing|in progress|underway|investigating)\b/i,
  /\bonce\s+(?:it|the (?:analysis|agent|exploration|review|audit)s?)\s+(?:is|are|has|have)?\s*(?:complete|done|finished|ready)/i,
  /\bI(?:'ve| have)\s+(?:launched|started|kicked off|spawned|dispatched)\b[^.]*\b(?:agent|analysis|exploration|review|audit)/i,
  /\bI(?:'ll| will)\s+(?:notify|tell|inform)\s+you\s+(?:when|once|as soon as)/i,
];

/**
 * True when an end-of-turn answer reads as a deferral rather than a synthesis of
 * child results already in hand. Gated by a length cap — a longer answer is plausibly
 * a real synthesis, so it is never flagged. Pure.
 */
export function looksLikeChildSynthesisPunt(answer: string, opts: { maxLen?: number } = {}): boolean {
  const text = (answer ?? '').trim();
  if (!text) return false;
  const maxLen = opts.maxLen ?? 700;
  if (text.length > maxLen) return false;
  return PUNT_PATTERNS.some((re) => re.test(text));
}
