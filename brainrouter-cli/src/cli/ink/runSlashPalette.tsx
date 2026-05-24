import React from 'react';
import { render } from 'ink';
import { SlashPalette, type SlashCommandDef, type SlashPaletteResult } from './SlashPalette.js';

/**
 * Mount the slash palette Ink app and await the user's selection.
 *
 * Returns:
 *   { kind: 'submit', text }  — the full command line to feed to the REPL
 *                              (e.g. "/help" or "/spawn researcher  prompt…")
 *   { kind: 'cancelled' }     — user pressed Esc or backspaced past the slash
 *
 * Both readline and Ink want to own stdout. The caller (REPL) must
 * `rl.pause()` before mounting and `rl.resume()` after — those are
 * intentionally NOT done here so the caller has explicit lifecycle
 * control (e.g. flush pending writes, refresh prompt color after).
 */
export interface RunSlashPaletteOptions {
  initialQuery: string;
  commands: SlashCommandDef[];
  accentColor?: string;
}

export async function runSlashPalette(opts: RunSlashPaletteOptions): Promise<SlashPaletteResult> {
  if (!process.stdin.isTTY) {
    return { kind: 'cancelled' };
  }
  return new Promise<SlashPaletteResult>((resolve) => {
    let resolved = false;
    const instance = render(
      <SlashPalette
        initialQuery={opts.initialQuery}
        commands={opts.commands}
        accentColor={opts.accentColor}
        onResolve={(r) => {
          if (resolved) return;
          resolved = true;
          // Unmount on the next tick so Ink finishes its last redraw
          // before we yank stdin away from it.
          setImmediate(() => {
            try { instance.unmount(); } catch { /* already gone */ }
            resolve(r);
          });
        }}
      />,
      { exitOnCtrlC: false }, // we handle Ctrl+C ourselves via Esc/cancel
    );
    // Defensive: if Ink exits on its own (e.g. parent killed), resolve
    // with cancelled so the caller doesn't hang.
    instance.waitUntilExit().catch(() => {
      if (!resolved) {
        resolved = true;
        resolve({ kind: 'cancelled' });
      }
    });
  });
}
