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
