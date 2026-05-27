import type readline from 'node:readline';
import chalk from 'chalk';
import { buildTheme, type Theme } from './theme.js';

/**
 * 0.3.7 — slash-command autosuggest popup.
 *
 * Renders a filtered list of slash commands BELOW the prompt as the
 * user types. Hides automatically when the input no longer starts
 * with `/`. Updates on every keystroke.
 *
 * Pattern lineage:
 *   - Two-tier ranking (exact → prefix → includes, lower wins, stable
 *     secondary sort by original index)
 *   - Popup height cap (max ~6 visible)
 *     and the Claude Code CHANGELOG note (line 378) explicitly
 *     capping the popup at "3-5 visible commands instead of scaling
 *     with terminal height."
 *
 * Render strategy (kept simple — no scroll-region tricks needed):
 *
 *   - On every keystroke we check `rl.line`. If it starts with `/`,
 *     compute the filtered list and (re)render the popup BELOW the
 *     current prompt line. The cursor is saved before the popup
 *     write and restored after — readline's prompt position stays
 *     untouched.
 *   - If the popup was previously visible AND should now be hidden
 *     (input no longer starts with `/`, or no matches), erase the
 *     popup region with `\x1b[J` from the position one line below
 *     the prompt.
 *
 * The function returns a controller you can wire into the REPL —
 * call `controller.onKey()` after each readline keypress to refresh.
 * Call `controller.hide()` on submit / cancel.
 */

const MAX_VISIBLE = 6;

export interface SlashCommand {
  /** "/help", "/config", etc. — the literal token the user types. */
  cmd: string;
  /** One-line description shown after the em-dash. */
  description: string;
}

export interface SlashSuggestController {
  /** Call after every readline keypress to refresh the popup. */
  onKey(): void;
  /** Force-hide the popup (called on submit / cancel). */
  hide(): void;
  /** Returns true while the popup is visible. */
  isVisible(): boolean;
}

export interface SlashSuggestOpts {
  rl: readline.Interface;
  commands: SlashCommand[];
  theme?: Theme;
}

/**
 * Two-tier rank for a single command against a query. Lower wins.
 *
 *   0  command starts with query (after the leading /)
 *   1  command contains query
 *   2  description contains query
 *   3  no match
 */
export function scoreSlashCommand(cmd: SlashCommand, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const cmdBody = cmd.cmd.slice(1).toLowerCase(); // skip the leading /
  if (cmdBody.startsWith(q)) return 0;
  if (cmdBody.includes(q)) return 1;
  if (cmd.description.toLowerCase().includes(q)) return 2;
  return 3;
}

export function filterAndSort(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) return commands.slice(0, MAX_VISIBLE);
  const scored = commands
    .map((c, i) => ({ c, i, s: scoreSlashCommand(c, query) }))
    .filter((x) => x.s < 3);
  scored.sort((a, b) => (a.s - b.s) || (a.i - b.i)); // stable by original index
  return scored.slice(0, MAX_VISIBLE).map((x) => x.c);
}

export function createSlashSuggest(opts: SlashSuggestOpts): SlashSuggestController {
  const theme = opts.theme ?? buildTheme('dark');
  const stdout = process.stdout;
  let lastVisible = false;
  let lastHeight = 0;
  let lastQuery = '';

  const readLine = (): string => {
    const rl = opts.rl as unknown as { line?: string };
    return rl.line ?? '';
  };

  const erase = () => {
    if (!lastVisible) return;
    // Save cursor → move to col 0 of next line → erase from cursor to
    // end of screen → restore cursor. `\x1b[s` and `\x1b[u` are the
    // SCO sequences; widely supported.
    stdout.write('\x1b7'); // DECSC — save cursor + attrs (more reliable than \x1b[s in xterm)
    stdout.write('\n');     // move down one
    stdout.write('\r');     // col 0
    stdout.write('\x1b[J'); // erase from here to end of screen
    stdout.write('\x1b8'); // DECRC — restore cursor
    lastVisible = false;
    lastHeight = 0;
  };

  const render = (matches: SlashCommand[]) => {
    // Pad command column for alignment.
    const cmdWidth = Math.max(...matches.map((m) => m.cmd.length));
    const lines = matches.map((m, idx) => {
      const cmdPart = theme.heading(m.cmd.padEnd(cmdWidth, ' '));
      const arrow = theme.dim('—');
      const desc = theme.muted(m.description);
      // First match gets a `›` marker; others a space.
      const marker = idx === 0 ? theme.primary('›') : ' ';
      return `  ${marker} ${cmdPart}  ${arrow}  ${desc}`;
    });
    // Hint line under the suggestions.
    lines.push(theme.dim('    Tab to autocomplete  ·  Enter to submit  ·  type to filter'));

    // First, erase any previous popup.
    if (lastVisible) {
      stdout.write('\x1b7');
      stdout.write('\n\r\x1b[J');
      stdout.write('\x1b8');
    }
    // Now draw the new popup below the prompt:
    stdout.write('\x1b7');
    stdout.write('\n'); // step down to a new line
    stdout.write('\r');
    for (let i = 0; i < lines.length; i++) {
      stdout.write(lines[i]);
      if (i < lines.length - 1) stdout.write('\n\r');
    }
    stdout.write('\x1b8'); // restore cursor to the prompt input position
    lastVisible = true;
    lastHeight = lines.length;
  };

  return {
    onKey: () => {
      const line = readLine();
      if (!line.startsWith('/')) {
        if (lastVisible) erase();
        lastQuery = '';
        return;
      }
      const query = line.slice(1);
      if (query === lastQuery && lastVisible) return; // no-op
      lastQuery = query;
      const matches = filterAndSort(opts.commands, query);
      if (matches.length === 0) {
        if (lastVisible) erase();
        return;
      }
      render(matches);
    },
    hide: () => { erase(); lastQuery = ''; },
    isVisible: () => lastVisible,
  };
}
