/**
 * ADR-028 S2-1 — the `gh stack` runner.
 *
 * One chokepoint for every stack command, so three rules hold everywhere
 * instead of being remembered at each call site:
 *
 *  1. Capability is checked FIRST (A1). Where the extension is absent, commands
 *     are not attempted — they are reported unavailable, so the caller hides
 *     the action rather than retrying a failure that can never clear.
 *  2. Every exit code is classified (A3). Callers act on an outcome, never on a
 *     number they re-interpret themselves.
 *  3. A halting outcome LATCHES. Once a rebase conflict, a rebase in progress,
 *     or a recovery-needed state is seen, further mutation is refused until a
 *     human clears it. The alternative — each command deciding independently —
 *     is how a second command lands on a half-finished working tree.
 *
 * Rule 3 is the one that needs state, and it is why this is a class rather than
 * a function.
 */
import {
  classifyStackExit,
  blocksFurtherMutation,
  type StackOutcome,
} from './stackExitCodes.js';
import type { StackCapability } from './stackCapability.js';

export interface StackExec {
  /** Run `gh stack …`; resolve with exit code and output, never reject. */
  (args: readonly string[], opts?: { timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface StackRunResult {
  outcome: StackOutcome;
  stdout: string;
  stderr: string;
  /** The argv actually run, for the activity log. */
  command: readonly string[];
}

export class StackUnavailableError extends Error {
  constructor(readonly capability: StackCapability) {
    super(capability.reason ?? 'Stacked pull requests are not available here.');
    this.name = 'StackUnavailableError';
  }
}

export class StackHaltedError extends Error {
  constructor(readonly outcome: StackOutcome) {
    super(
      `Stack operations are halted: ${outcome.guidance} ` +
      'Clear this before running another stack command.',
    );
    this.name = 'StackHaltedError';
  }
}

/** Commands that only read. These stay available while mutation is halted. */
const READ_ONLY = new Set(['view', 'checkout', 'switch', 'up', 'down', 'top', 'bottom', 'trunk']);

export interface StackRunnerOptions {
  exec: StackExec;
  capability: StackCapability;
  /** Default per-command timeout. Merge overrides this — see A5. */
  timeoutMs?: number;
}

export class StackRunner {
  private halted: StackOutcome | null = null;

  constructor(private readonly options: StackRunnerOptions) {}

  /** The latched halting outcome, when there is one. */
  get haltedBy(): StackOutcome | null {
    return this.halted;
  }

  /**
   * Clear a latched halt.
   *
   * Deliberately explicit: nothing clears this automatically, because the
   * conditions that set it (a conflicted rebase, a stack needing recovery) are
   * resolved by a human doing something outside this process, and we cannot
   * observe that they did it correctly.
   */
  clearHalt(): void {
    this.halted = null;
  }

  /**
   * Run one `gh stack` subcommand.
   *
   * Throws only for the two states where *attempting* is wrong: the feature is
   * unavailable, or mutation is halted. Ordinary command failure is returned as
   * an outcome, because "the command failed" is information the caller needs
   * rather than an exception to catch.
   */
  async run(
    args: readonly string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<StackRunResult> {
    if (!this.options.capability.available) {
      throw new StackUnavailableError(this.options.capability);
    }
    const subcommand = args[0] ?? '';
    const mutating = !READ_ONLY.has(subcommand);
    if (mutating && this.halted) {
      throw new StackHaltedError(this.halted);
    }

    const command = ['stack', ...args] as const;
    const result = await this.options.exec(command, {
      timeoutMs: opts.timeoutMs ?? this.options.timeoutMs ?? 30_000,
    });
    const outcome = classifyStackExit(result.exitCode);

    // Latch here rather than at the call site: a caller that forgets leaves the
    // next command free to land on a half-finished tree.
    if (blocksFurtherMutation(outcome) && outcome.kind !== 'feature_disabled') {
      this.halted = outcome;
    }

    return { outcome, stdout: result.stdout, stderr: result.stderr, command };
  }
}

/**
 * Is this repository's stack support usable AND not halted?
 *
 * Used to decide whether to OFFER an action. Distinct from `run` throwing:
 * asking before offering is how the action stays hidden rather than visible
 * and failing.
 */
export function stackActionsAvailable(runner: StackRunner, capability: StackCapability): boolean {
  return capability.available && runner.haltedBy === null;
}
