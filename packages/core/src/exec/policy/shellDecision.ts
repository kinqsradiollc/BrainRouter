/**
 * ADR-061 D3.1 — shell risk, above the rule floor.
 *
 * `shellClassifier.ts` is good at DESTRUCTION: `rm -rf`, `curl | sh`,
 * `find . -delete` and `aws s3 rm --recursive` are all on its list. It has no
 * entry for the other kind of irreversible — PUBLICATION. `npm publish`,
 * `terraform apply -auto-approve` and `gh release create` are all classified
 * safe, because nobody wrote them down, and the next one nobody writes down
 * will be too. The classifier's outcome is already three-way — allow / ask /
 * deny — but the middle is only reachable by a rule hit, so a command nobody
 * anticipated lands on whichever side the last pattern happened to fall.
 *
 * This asks one `noul` about the commands the rules ALLOWED: *is this too risky
 * or insufficiently authorized for what the user actually asked for?* The rule
 * floor is untouched — a rule that denies still denies, a rule that asks still
 * asks, and this is consulted only where the rules had nothing to say.
 *
 * Because the floor already allowed, the question's `rulesAnswer` is 0. With
 * the default `rules` provider that yields probability 0, which is below any
 * legal `low` threshold, which is `allow` — so the gate behaves byte-for-byte
 * as it did before this file existed. That equivalence is the point, and it is
 * pinned by a test.
 */

import type { DecisionAnswer, DecisionPort, DecisionState } from '../../decision/types.js';

export interface ShellRiskThresholds {
  /** Below this, allow. */
  low: number;
  /** At or above this, deny outright. Between the two, ask a human. */
  high: number;
}

export const SHELL_RISK_DEFAULT_THRESHOLDS: ShellRiskThresholds = { low: 0.3, high: 0.8 };

export interface ShellRiskInput {
  /** The command as the model wrote it. */
  command: string;
  /** What the user actually asked for this turn — the authorization context. */
  userIntent?: string;
  /** Where it would run, when that is not the workspace root. */
  cwd?: string;
}

export interface ShellRiskVerdict {
  decision: 'allow' | 'ask' | 'deny';
  /** One sentence a person reads on the approval card or the refusal. */
  reason: string;
  /** The answer, for the recorder — probability, provider, fallback, latency. */
  answer: DecisionAnswer;
  /** Which band the probability fell in, recorded beside the decision. */
  threshold: string;
}

const QUESTION_ID = 'risky';

const INSTRUCTIONS =
  'Is running this shell command too risky, or not authorized by what the user asked for? '
  + 'Risky means it destroys work, publishes or deploys something, spends money, changes '
  + 'state outside the workspace, or exfiltrates data. A command that only reads, builds, '
  + 'tests, or edits files inside the workspace the user is working in is not risky.';

/**
 * Build the state the provider sees. Redaction is the CALLER's — it owns the
 * chokepoint — and the bound is applied here so no consumer can forget it (D4).
 */
export function shellDecisionState(input: ShellRiskInput, maxChars: number): DecisionState {
  const bound = (value: string | undefined, share: number): string | undefined => {
    if (!value) return undefined;
    const limit = Math.max(40, Math.floor(maxChars * share));
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  };
  return {
    command: bound(input.command, 0.5) ?? '',
    ...(input.cwd ? { cwd: bound(input.cwd, 0.15) } : {}),
    ...(input.userIntent ? { userAsked: bound(input.userIntent, 0.35) } : {}),
  };
}

/**
 * Ask about a command the rule floor already allowed.
 *
 * Never throws: the port answers with the rules floor on any provider trouble,
 * and the floor here means `allow` — the outcome the caller already had.
 */
export async function decideShellRisk(
  port: DecisionPort,
  input: ShellRiskInput,
  options: { thresholds?: ShellRiskThresholds; maxStateChars?: number } = {},
): Promise<ShellRiskVerdict> {
  const thresholds = normalizeThresholds(options.thresholds);
  const answers = await port.ask(
    shellDecisionState(input, options.maxStateChars ?? 8_000),
    {
      [QUESTION_ID]: {
        kind: 'noul',
        instructions: INSTRUCTIONS,
        // The rules allowed it; that IS the floor's answer.
        rulesAnswer: 0,
      },
    },
  );
  const answer = answers[QUESTION_ID]!;
  const probability = typeof answer.value === 'number' ? answer.value : 0;

  if (probability >= thresholds.high) {
    return {
      decision: 'deny',
      reason:
        `the safety classifier put this at ${probability.toFixed(2)} risk `
        + `(at or above ${thresholds.high.toFixed(2)} is refused): it destroys, deploys, `
        + 'spends, or reaches outside the workspace, and the request does not call for it',
      answer,
      threshold: `>= high ${thresholds.high}`,
    };
  }
  if (probability >= thresholds.low) {
    return {
      decision: 'ask',
      reason:
        `the safety classifier is unsure about this one (${probability.toFixed(2)} risk, `
        + `the band between ${thresholds.low.toFixed(2)} and ${thresholds.high.toFixed(2)}) — `
        + 'no rule matched it, so it is your call',
      answer,
      threshold: `>= low ${thresholds.low}`,
    };
  }
  return {
    decision: 'allow',
    reason: `classified safe (${probability.toFixed(2)})`,
    answer,
    threshold: `< low ${thresholds.low}`,
  };
}

/** A misconfigured band must never invert the gate: clamp and order it. */
function normalizeThresholds(input?: ShellRiskThresholds): ShellRiskThresholds {
  const clamp = (v: number, fallback: number): number =>
    Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
  const low = clamp(input?.low ?? SHELL_RISK_DEFAULT_THRESHOLDS.low, SHELL_RISK_DEFAULT_THRESHOLDS.low);
  const high = clamp(input?.high ?? SHELL_RISK_DEFAULT_THRESHOLDS.high, SHELL_RISK_DEFAULT_THRESHOLDS.high);
  // `low > high` is a typo, not a policy. Collapsing it to the stricter bound
  // would silently make the gate maximally aggressive; the documented defaults
  // are the predictable reading of a band that cannot be read.
  return low <= high ? { low, high } : { ...SHELL_RISK_DEFAULT_THRESHOLDS };
}
