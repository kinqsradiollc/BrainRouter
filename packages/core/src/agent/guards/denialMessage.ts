/**
 * CC-P6.8 — denied-tool semantics (0.4.15 thread B).
 *
 * When a tool call is DENIED — by the user declining an approval prompt, by a
 * hook gate, or by the execution policy / access mode — the result text the
 * model sees must communicate the right thing: *the user (or their policy)
 * declined this; adjust your approach, do NOT retry the same call*. The strong
 * reference agents treat a denial as a signal to change course; weaker OS
 * models instead loop-retry the identical call (or an equivalent one), which
 * the repeat-loop guard then has to break.
 *
 * `classifyDenial` detects a denial from the thrown error message (the denial
 * paths in agent.ts all throw); `formatDenialResult` rewrites it into a tool
 * result that states the decline + the adjust-don't-retry contract. Pure.
 */

export type DenialReason = 'user-declined' | 'hook-blocked' | 'policy' | 'access-mode';

const PATTERNS: Array<{ kind: DenialReason; re: RegExp }> = [
  { kind: 'user-declined', re: /rejected by (parent approval|user)|declined by the user|user declined/i },
  { kind: 'hook-blocked', re: /denied by .*hook|blocked by .*hook|hook .* (blocked|denied)/i },
  { kind: 'access-mode', re: /not permitted in access mode/i },
  { kind: 'policy', re: /denied by execution policy|denied: dangerous|execution denied|denied:/i },
];

/** Classify a thrown tool error as a denial, or null if it's an ordinary failure. Pure. */
export function classifyDenial(message: string): DenialReason | null {
  const m = message ?? '';
  for (const { kind, re } of PATTERNS) if (re.test(m)) return kind;
  return null;
}

/**
 * Build the tool-result text for a denied call. States WHO declined and the
 * contract: adjust, don't retry the same call. Pure.
 */
export function formatDenialResult(name: string, reason: DenialReason, detail: string): string {
  const who =
    reason === 'user-declined'
      ? 'The user DECLINED this tool call'
      : reason === 'hook-blocked'
        ? 'A workspace hook BLOCKED this tool call'
        : reason === 'access-mode'
          ? 'This tool is NOT ALLOWED in the current access mode'
          : 'The execution policy DENIED this tool call';
  return [
    `${who}: ${name}.`,
    detail ? `Reason: ${detail}` : '',
    '',
    'A denial is a decision, not a transient error. Do NOT retry the same call (verbatim or trivially reworded) — the repeat-loop guard will block it anyway.',
    'Instead: take a different path to the goal that does not need this exact action, or — if there is no alternative — explain to the user what you were trying to do and why it is blocked, and ask how they want to proceed.',
  ].filter(Boolean).join('\n');
}
