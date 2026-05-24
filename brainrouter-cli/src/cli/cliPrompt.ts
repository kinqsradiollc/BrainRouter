import readline from 'node:readline';

/**
 * Shared bridge between the REPL's readline interface and modules outside
 * repl.ts that need to (a) write above the prompt without scrambling input,
 * or (b) ask the user a one-shot question while a turn is in progress
 * (e.g. run_command approval).
 *
 * Previously this used `inquirer.prompt`. Inquirer creates its OWN readline
 * interface attached to the same `process.stdin`, and on exit it leaves stray
 * `line` events that the parent REPL then sees as "the user typed a new
 * prompt while a turn is still running". Using the parent rl directly avoids
 * that.
 *
 * Only one REPL exists per process, so a module-level pointer is fine.
 */

let activeReadline: readline.Interface | undefined;

export function setActiveReadline(rl: readline.Interface | undefined): void {
  activeReadline = rl;
}

export function getActiveReadline(): readline.Interface | undefined {
  return activeReadline;
}

/**
 * One-shot yes/no question. Returns true only when the user types y/yes
 * (case-insensitive). Returns the supplied default when stdin isn't a TTY
 * (e.g. piped non-interactive runs).
 */
export function askYesNo(question: string, defaultValue = false): Promise<boolean> {
  if (!activeReadline || !process.stdin.isTTY) {
    return Promise.resolve(defaultValue);
  }
  return new Promise((resolve) => {
    const rl = activeReadline!;
    // The parent rl was paused by runAgentTurn; resume so it actually reads
    // keystrokes. We re-pause once we have the answer.
    rl.resume();
    rl.question(question, (answer) => {
      const lower = (answer ?? '').trim().toLowerCase();
      const yes = lower === 'y' || lower === 'yes';
      rl.pause();
      resolve(yes);
    });
  });
}

/**
 * Surfaced when `askChoice` is called outside an interactive TTY. The tool
 * wrapper turns this into a tool-call error so the LLM falls back to deciding
 * itself — silently picking option 1 for the agent in CI / piped runs would
 * make a load-bearing decision the user never saw.
 */
export class NoTTYError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoTTYError';
  }
}

/**
 * Surfaced when a partial label match resolves to 2+ options. Refusing
 * to silently pick one is the whole reason this helper exists: the agent
 * is asking the user to commit to ONE of N reasonable approaches, and
 * "I guessed which one you meant" defeats the purpose.
 */
export class AmbiguousChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousChoiceError';
  }
}

export interface ChoiceOption {
  label: string;
  description: string;
}

/**
 * Multi-choice mid-turn prompt. Mirrors `askYesNo`'s structural pattern
 * (activeReadline bridge, rl.resume/pause dance) so it composes with the
 * parent REPL the same way.
 *
 * Validation accepts an option number (1-based) OR a case-insensitive label
 * match (exact wins outright; otherwise unique prefix; otherwise throws
 * `AmbiguousChoiceError`).
 *
 * Non-TTY behavior is strict: throws `NoTTYError` instead of defaulting to
 * option 1. The agent calling this is asking the human for judgment; making
 * the call for them in CI / piped / `brainrouter run` would silently commit
 * to a path the user never saw.
 */
export function askChoice(
  question: string,
  options: ChoiceOption[],
  opts: { multiSelect?: boolean } = {},
): Promise<string | string[]> {
  if (!activeReadline || !process.stdin.isTTY) {
    return Promise.reject(
      new NoTTYError(
        'ask_user_choice requires an interactive TTY (no readline interface is active or stdin is not a TTY). ' +
        'Fall back to deciding yourself based on the available context, and state which option you picked and why in your reply.',
      ),
    );
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    const count = Array.isArray(options) ? options.length : 'invalid';
    return Promise.reject(
      new Error(`ask_user_choice requires 2–4 options; received ${count}.`),
    );
  }
  const rl = activeReadline;
  const lines: string[] = [question.trim()];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    lines.push(`  ${i + 1}. ${o.label} — ${o.description}`);
  }
  const tail = opts.multiSelect
    ? 'Choose one or more (numbers/labels, comma-separated): '
    : 'Choose one (number or label): ';
  const prompt = `${lines.join('\n')}\n${tail}`;

  return new Promise((resolve, reject) => {
    rl.resume();
    rl.question(prompt, (answer) => {
      rl.pause();
      try {
        const raw = (answer ?? '').trim();
        if (!raw) {
          reject(new Error('ask_user_choice received an empty answer.'));
          return;
        }
        if (opts.multiSelect) {
          const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
          if (tokens.length === 0) {
            reject(new Error('ask_user_choice received an empty answer.'));
            return;
          }
          const resolved = tokens.map((tok) => resolveChoiceToken(tok, options));
          // Dedupe while preserving order — a stray "2,2" shouldn't return two copies.
          resolve(Array.from(new Set(resolved)));
        } else {
          resolve(resolveChoiceToken(raw, options));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

function resolveChoiceToken(token: string, options: ChoiceOption[]): string {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > options.length) {
      throw new Error(
        `Option ${n} is out of range; pick 1–${options.length} or use a label.`,
      );
    }
    return options[n - 1].label;
  }
  const lower = token.toLowerCase();
  // Exact (case-insensitive) match wins outright — even if it's also a prefix
  // of another label, exact form is unambiguous user intent.
  const exact = options.find((o) => o.label.toLowerCase() === lower);
  if (exact) return exact.label;
  const prefixMatches = options.filter((o) => o.label.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0].label;
  if (prefixMatches.length > 1) {
    const names = prefixMatches.map((o) => o.label).join(', ');
    throw new AmbiguousChoiceError(
      `Answer "${token}" is ambiguous — matches multiple options: ${names}. Type the full label or the option number.`,
    );
  }
  const names = options.map((o) => o.label).join(', ');
  throw new Error(
    `Answer "${token}" did not match any option (${names}). Pick a number 1–${options.length} or a label prefix.`,
  );
}

/**
 * Print a line of output while the prompt is showing, then redraw the prompt
 * with whatever the user was mid-typing. Used by callbacks that fire while the
 * REPL is idle (child agents that complete async after the parent turn ended).
 */
export function safePrintAbovePrompt(msg: string): void {
  if (!process.stdout.isTTY || !activeReadline) {
    console.log(msg);
    return;
  }
  process.stdout.write('\r\x1b[2K');
  console.log(msg);
  try { (activeReadline as any)._refreshLine?.(); } catch { activeReadline.prompt(true); }
}
