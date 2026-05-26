import React from 'react';
import { SlashPalette, type SlashCommandDef, type SlashPaletteResult } from './SlashPalette.js';
import { resetStdinForReadline, snapshotStdinListeners } from './stdinHandoff.js';
import { renderWithResizeClear } from './renderWithResizeClear.js';

/**
 * Mount the slash palette Ink app and await the user's selection.
 *
 * Returns:
 *   { kind: 'submit', text }  — full command line to feed to the REPL
 *   { kind: 'cancelled' }     — user pressed Esc / backspaced past `/`
 *
 * Stdin handoff (matters):
 *   - Before mount: snapshot + remove ALL `keypress` / `data`
 *     listeners on process.stdin. Otherwise readline (which is paused
 *     but still listening) AND Ink both consume bytes — arrow keys
 *     get split between them and the palette appears frozen.
 *   - After Ink unmount: restore the snapshotted listeners + run
 *     `resetStdinForReadline` so the surrounding REPL doesn't exit
 *     due to Ink's `stdin.unref()` cleanup.
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
  // Snapshot + detach existing stdin listeners so Ink owns stdin
  // alone for its mount lifetime.
  const snap = snapshotStdinListeners(['keypress', 'data']);
  return new Promise<SlashPaletteResult>((resolve) => {
    let captured: SlashPaletteResult | undefined;
    const { instance, cleanupResizeClear } = renderWithResizeClear(
      <SlashPalette
        initialQuery={opts.initialQuery}
        commands={opts.commands}
        accentColor={opts.accentColor}
        onResolve={(r) => {
          // Capture; the actual `resolve()` runs after Ink's unmount
          // finishes via `waitUntilExit().then`.
          if (captured) return;
          captured = r;
        }}
      />,
      { exitOnCtrlC: false },
    );
    instance.waitUntilExit().then(() => {
      cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    }).catch(() => {
      cleanupResizeClear();
      snap.restore();
      resetStdinForReadline();
      resolve(captured ?? { kind: 'cancelled' });
    });
  });
}
