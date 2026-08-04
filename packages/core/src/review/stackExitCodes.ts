/**
 * ADR-028 A3 — `gh stack` exit codes are the contract.
 *
 * The extension returns a distinct code per failure class. Collapsing them into
 * "something went wrong" loses the only information that decides what to do
 * next: "this repository has stacks turned off" and "a rebase is half-finished
 * in your working tree" demand opposite responses, and one of them is a case
 * where retrying destroys work.
 *
 * Three outcomes matter more than the rest:
 *
 *   9  FEATURE DISABLED  — stop offering stack actions here. Retrying is
 *      pointless and reads as a bug in us.
 *   3/7 CONFLICT or REBASE IN PROGRESS — the working tree holds a half-finished
 *      operation. A second stack command on top of it compounds the mess.
 *   10 RECOVERY NEEDED   — refuse all further mutation. This is the one where
 *      guessing can lose committed work.
 *
 * Codes come from GitHub's published reference for the extension.
 */

export type StackOutcomeKind =
  | 'ok'
  | 'generic_error'
  | 'not_in_stack'
  | 'rebase_conflict'
  | 'api_failure'
  | 'invalid_arguments'
  | 'disambiguation_required'
  | 'rebase_in_progress'
  | 'stack_locked'
  | 'feature_disabled'
  | 'recovery_needed'
  | 'unknown_code';

export interface StackOutcome {
  kind: StackOutcomeKind;
  exitCode: number;
  /** True only for exit 0. */
  ok: boolean;
  /**
   * True when the working tree or remote state means NO further stack command
   * may run until a human intervenes. Distinct from "this command failed".
   */
  halts: boolean;
  /**
   * True when stack support is unavailable for this repository, so the actions
   * should be hidden rather than offered and failing (A1).
   */
  unavailable: boolean;
  /** Whether retrying the same command could plausibly succeed. */
  retryable: boolean;
  /** What the human or agent should do next. Always populated. */
  guidance: string;
}

interface CodeSpec {
  kind: StackOutcomeKind;
  halts?: boolean;
  unavailable?: boolean;
  retryable?: boolean;
  guidance: string;
}

const CODES: Readonly<Record<number, CodeSpec>> = {
  0: { kind: 'ok', guidance: 'Succeeded.' },
  1: {
    kind: 'generic_error',
    guidance: 'The command failed without a specific cause. Read the output before retrying.',
  },
  2: {
    kind: 'not_in_stack',
    guidance:
      'This branch or pull request is not part of a stack. That is an ordinary state, not a failure — ' +
      'create one with `gh stack init` if a stack is what you wanted.',
  },
  3: {
    kind: 'rebase_conflict',
    halts: true,
    guidance:
      'A rebase hit a conflict and the working tree is mid-operation. Resolve it and continue, or ' +
      'abort. Do NOT run another stack command first — it will compound the half-finished state.',
  },
  4: {
    kind: 'api_failure',
    retryable: true,
    guidance: 'GitHub returned an error. Transient failures are worth one retry; repeated ones are not.',
  },
  5: {
    kind: 'invalid_arguments',
    guidance: 'The command was called wrongly. Retrying unchanged cannot help.',
  },
  6: {
    kind: 'disambiguation_required',
    guidance:
      'The target was ambiguous — more than one stack or branch matched. Name it explicitly by ' +
      'stack number, pull request number, or branch.',
  },
  7: {
    kind: 'rebase_in_progress',
    halts: true,
    guidance:
      'A rebase is already in progress in this working tree. Finish or abort it before any other ' +
      'stack operation.',
  },
  8: {
    kind: 'stack_locked',
    retryable: true,
    guidance:
      'The stack is locked by another operation, possibly on another machine. Wait and retry; if it ' +
      'persists, something is holding the lock that should not be.',
  },
  9: {
    kind: 'feature_disabled',
    unavailable: true,
    guidance:
      'Stacked pull requests are not enabled for this repository. Stop offering stack actions here — ' +
      'retrying is pointless and looks like a defect in us rather than a repository setting.',
  },
  10: {
    kind: 'recovery_needed',
    halts: true,
    guidance:
      'The stack is in a state the extension cannot resolve on its own and RECOVERY IS REQUIRED. ' +
      'Refuse all further stack mutation and hand this to a human — continuing from here can lose ' +
      'committed work.',
  },
};

/**
 * Classify an exit code.
 *
 * An UNRECOGNISED code is deliberately treated as halting. The extension is in
 * preview and may add codes; assuming an unknown failure is safe to continue
 * through is exactly the assumption that turns a new error class into data
 * loss. Erring toward stopping costs a manual retry.
 */
export function classifyStackExit(exitCode: number): StackOutcome {
  const spec = CODES[exitCode];
  if (!spec) {
    return {
      kind: 'unknown_code',
      exitCode,
      ok: false,
      halts: true,
      unavailable: false,
      retryable: false,
      guidance:
        `\`gh stack\` returned an unrecognised exit code (${exitCode}). The extension is in preview ` +
        'and may have added a failure class we do not know. Treating it as halting rather than ' +
        'assuming it is safe to continue through.',
    };
  }
  return {
    kind: spec.kind,
    exitCode,
    ok: spec.kind === 'ok',
    halts: spec.halts === true,
    unavailable: spec.unavailable === true,
    retryable: spec.retryable === true,
    guidance: spec.guidance,
  };
}

/** Every code we know, for tests and for the capability probe. */
export const KNOWN_STACK_EXIT_CODES: readonly number[] =
  Object.keys(CODES).map(Number).sort((a, b) => a - b);

/**
 * Should stack MUTATION be refused given the most recent outcome?
 *
 * Kept separate from `classifyStackExit` because the answer is about session
 * state, not about one command: once a halting outcome is seen, subsequent
 * commands stay refused until a human clears it, and that is a decision the
 * caller holds rather than something re-derived per invocation.
 */
export function blocksFurtherMutation(outcome: StackOutcome): boolean {
  return outcome.halts || outcome.unavailable;
}
