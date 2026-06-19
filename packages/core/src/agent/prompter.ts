/**
 * §ADR-003 injection seam — the headless engine must NOT import the CLI's
 * interactive (readline/ink) prompt layer. The Agent asks the user through this
 * injected `InteractivePrompter` port instead. The CLI injects a TTY-backed
 * implementation (delegating to `cli/cliPrompt`); the Desktop and any other
 * headless host use the default {@link HEADLESS_PROMPTER}, which refuses with a
 * `NoTTYError` exactly as the old direct calls did when no TTY was attached.
 */

/** Thrown when an interactive prompt is requested but no TTY is available. The
 * Agent catches it and falls back to deciding for itself. Defined here so the
 * CLI and the headless paths share ONE class (instanceof checks stay valid). */
export class NoTTYError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoTTYError';
  }
}

/** A single choice presented by {@link InteractivePrompter.askChoice}. Matches
 * the CLI picker's `ChoiceOption` so the TTY prompter assigns without an adapter. */
export interface PrompterChoiceOption {
  label: string;
  description: string;
}

/** The user-prompting surface the Agent depends on — satisfied by the CLI's
 * TTY prompter or the headless stub. Structural so the CLI's richer
 * `cliPrompt` functions assign without importing this type. */
export interface InteractivePrompter {
  /** The active readline interface, or undefined when there is no TTY. */
  getActiveReadline(): unknown;
  /** Yes/no confirmation; throws {@link NoTTYError} when there is no TTY. */
  askYesNo(question: string, defaultValue?: boolean): Promise<boolean>;
  /** Single/multi choice; throws {@link NoTTYError} when there is no TTY. */
  askChoice(
    question: string,
    options: PrompterChoiceOption[],
    opts?: { multiSelect?: boolean; header?: string },
  ): Promise<string | string[]>;
}

const NO_TTY = 'No interactive terminal is attached. Decide yourself and state which option you picked and why.';

/** Default prompter for headless hosts (Desktop, children, tests): there is no
 * TTY, so every prompt refuses — mirroring the CLI's behavior when no readline
 * is active. Interactive hosts inject their own. */
export const HEADLESS_PROMPTER: InteractivePrompter = {
  getActiveReadline: () => undefined,
  askYesNo: async () => { throw new NoTTYError(NO_TTY); },
  askChoice: async () => { throw new NoTTYError(NO_TTY); },
};
