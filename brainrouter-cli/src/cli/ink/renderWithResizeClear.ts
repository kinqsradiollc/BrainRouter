import type { ReactNode } from 'react';
import { render, type Instance, type RenderOptions } from 'ink';
import { getCliKnobs } from '../../config/config.js';

export interface ResizeClearInkInstance {
  instance: Instance;
  cleanupResizeClear: () => void;
}

const ERASE_SCROLLBACK = '\x1b[3J';
// Alternate screen buffer enter/exit sequences. Modern TUIs (vim,
// less, htop, gh's interactive mode) use the alt-screen so external
// processes writing to the same TTY can't corrupt the frame. When the
// chat REPL has the alt-screen, sibling processes (a brainrouter
// server running in the same shell, a `tail -f` in another tab
// sharing the TTY, dotenv banners from late module loads) write to
// the MAIN screen — which is hidden while Ink owns the alt-screen —
// so their output simply doesn't appear.
//
// **Trade-off: alt-screen has NO scrollback.** Every modern terminal
// emulator (iTerm2, Terminal.app, kitty, Alacritty, Windows Terminal)
// disables mousewheel / two-finger scroll inside the alt-screen because
// the alt-screen is a fixed-size grid by spec — there's nothing
// "above" the frame to scroll to. Users hit this as "after a while I
// can no longer scroll." Native scroll is a bigger UX win than
// sibling-process isolation for the common single-shell case, so the
// default flipped from ON → OFF in 0.3.9. Opt back IN with
// `BRAINROUTER_ALT_SCREEN=1` if a sibling process is corrupting
// frames in your terminal.
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
// Hide / show the OS cursor while the Ink frame owns the screen. The
// gray ▍ block-cursor in the live row IS our cursor; the OS one
// blinking on top is visual noise that adds to the "flashing" feel.
// Independent of alt-screen — we want a clean single cursor in both
// alt-screen mode AND main-screen mode. Opt out with
// `BRAINROUTER_SHOW_CURSOR=1` if you actually want both cursors.
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Returns true ONLY when the user explicitly opted in via
 * `BRAINROUTER_ALT_SCREEN=1`. Off by default in 0.3.9+ to preserve
 * native terminal scrollback — mousewheel and two-finger scroll stop
 * working in alt-screen mode (no scrollback by spec).
 *
 * Also off for non-TTY contexts (CI, pipes, tests) since the escape
 * sequence would just produce garbage in captured output.
 *
 * The legacy `BRAINROUTER_NO_ALT_SCREEN=1` env var is honoured for
 * back-compat: if it's set, alt-screen stays off regardless of the
 * positive opt-in flag.
 */
export function shouldUseAltScreen(stdout: NodeJS.WriteStream): boolean {
  if (!stdout.isTTY) return false;
  // Reads `config.cli.altScreen` (default false in 0.3.9+ to preserve
  // native terminal scrollback).
  return getCliKnobs().altScreen === true;
}

/**
 * Hide the OS cursor unless `config.cli.hideCursor` is explicitly false.
 * Default true so the chat REPL gets a clean single-cursor experience.
 */
export function shouldHideCursor(stdout: NodeJS.WriteStream): boolean {
  if (!stdout.isTTY) return false;
  return getCliKnobs().hideCursor === true;
}

/**
 * Ink only force-clears on selected resize paths. BrainRouter's Ink
 * panels redraw full frames, so every terminal resize must clear the
 * previous frame first or old banners/prompts can remain in scrollback.
 * We also clear the terminal scrollback buffer so stale resize frames
 * cannot be reached by scrolling up after the layout settles.
 *
 * In TTY contexts we additionally switch to the alternate screen
 * buffer so the chat REPL is isolated from any sibling-process writes
 * to the same TTY (see ENTER_ALT_SCREEN comment). Opt-out via
 * BRAINROUTER_NO_ALT_SCREEN=1.
 */
export function renderWithResizeClear(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): ResizeClearInkInstance {
  const stdout = resolveStdout(options);
  const useAltScreen = shouldUseAltScreen(stdout);
  const hideCursor = shouldHideCursor(stdout);
  if (useAltScreen) {
    stdout.write(ENTER_ALT_SCREEN);
  }
  if (hideCursor) {
    stdout.write(HIDE_CURSOR);
  }
  const instance = render(node, options);
  // Resize handler.
  //
  // `instance.clear()` is load-bearing in BOTH modes: Ink's log-update
  // tracks "previous N lines" at the OLD terminal width. When the
  // width changes, the *visual* row count of the prior frame changes,
  // so log-update's "erase N lines" doesn't match the actual occupied
  // rows. Without an explicit clear, the old banner stays visible and
  // the new banner renders BELOW it — observed as duplicated banners
  // stacking down the screen on each resize.
  //
  // `ERASE_SCROLLBACK` (\x1b[3J) is the OTHER half of the old handler.
  // In alt-screen mode there is no user scrollback (it's alt-buffer
  // state), so wiping it is fine. In main-screen mode the scrollback
  // IS the user's history — wiping it on every resize feels like "I
  // lost my context." So we only fire ERASE_SCROLLBACK in alt-screen.
  const clearBeforeResize = () => {
    instance.clear();
    if (useAltScreen && stdout.isTTY) {
      stdout.write(ERASE_SCROLLBACK);
    }
  };
  stdout.prependListener('resize', clearBeforeResize);
  // When Ink unmounts (Ctrl+C, Ctrl+D, /exit), restore the original
  // terminal state — exit alt-screen if we entered one, and re-show
  // the OS cursor if we hid it. Both restorations are independent.
  // Belt-and-suspenders: register both a process-exit hook AND expose
  // the toggle via cleanupResizeClear for the runChat finally-block.
  let cleanedUp = false;
  const restoreTerminal = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Show cursor FIRST while we're still on whichever buffer Ink
    // owned, then exit alt-screen so the main buffer sees a sane
    // cursor on the next prompt. Order matters: leaving alt-screen
    // first and then writing SHOW_CURSOR could land on the main
    // buffer's cursor instead.
    if (hideCursor) {
      stdout.write(SHOW_CURSOR);
    }
    if (useAltScreen) {
      stdout.write(EXIT_ALT_SCREEN);
    }
  };
  // Catch hard-exit paths (signal, uncaught error) so the terminal
  // doesn't stay stuck in alt-screen or with a hidden cursor if the
  // process is killed before runChat's normal cleanup fires.
  process.once('exit', restoreTerminal);
  process.once('SIGINT', restoreTerminal);
  process.once('SIGTERM', restoreTerminal);
  return {
    instance,
    cleanupResizeClear: () => {
      stdout.off('resize', clearBeforeResize);
      restoreTerminal();
      process.off('exit', restoreTerminal);
      process.off('SIGINT', restoreTerminal);
      process.off('SIGTERM', restoreTerminal);
    },
  };
}

function resolveStdout(options?: NodeJS.WriteStream | RenderOptions): NodeJS.WriteStream {
  if (!options) return process.stdout;
  if ('write' in options && !('stdout' in options)) return options as NodeJS.WriteStream;
  return ((options as RenderOptions).stdout as NodeJS.WriteStream | undefined) ?? process.stdout;
}
