import type { ReactNode } from 'react';
import { render, type Instance, type RenderOptions } from 'ink';

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
// so their output simply doesn't appear. On exit we switch back and
// the user's shell scrollback is intact. Without alt-screen, those
// external writes push Ink's frame down and the next redraw overwrites
// the wrong rows, producing the "first message scrolls + text overlap"
// rendering bug (e.g. `keepings.` ghosting from a longer prior line).
const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
// Hide / show the OS cursor while the Ink frame owns the screen. The
// gray ▍ block-cursor in the live row IS our cursor; the OS one
// blinking on top is visual noise that adds to the "flashing" feel.
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Returns true unless the user explicitly opted out via
 * BRAINROUTER_NO_ALT_SCREEN=1. Off by default for non-TTY contexts
 * (CI, pipes, tests) since the escape sequence would just produce
 * garbage in the captured output.
 */
function shouldUseAltScreen(stdout: NodeJS.WriteStream): boolean {
  if (!stdout.isTTY) return false;
  const opt = process.env.BRAINROUTER_NO_ALT_SCREEN;
  if (opt === '1' || opt === 'true') return false;
  return true;
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
  if (useAltScreen) {
    stdout.write(ENTER_ALT_SCREEN);
    stdout.write(HIDE_CURSOR);
  }
  const instance = render(node, options);
  const clearBeforeResize = () => {
    instance.clear();
    if (stdout.isTTY) {
      stdout.write(ERASE_SCROLLBACK);
    }
  };
  stdout.prependListener('resize', clearBeforeResize);
  // When Ink unmounts (Ctrl+C, Ctrl+D, /exit), exit alt-screen so the
  // user's shell is visible again. waitUntilExit() resolves AFTER
  // ink's render loop tears down; we hook into the same cleanup
  // callback by chaining off it via .then on the consumer side, OR
  // by listening to process exit. Belt-and-suspenders: register both
  // a process-exit hook AND expose the toggle via cleanupResizeClear
  // for the runChat finally-block.
  let altScreenExited = false;
  const exitAltScreen = () => {
    if (altScreenExited) return;
    altScreenExited = true;
    if (useAltScreen) {
      stdout.write(SHOW_CURSOR);
      stdout.write(EXIT_ALT_SCREEN);
    }
  };
  // Catch hard-exit paths (signal, uncaught error) so the terminal
  // doesn't stay stuck in alt-screen with a hidden cursor if the
  // process is killed before runChat's normal cleanup fires.
  process.once('exit', exitAltScreen);
  process.once('SIGINT', exitAltScreen);
  process.once('SIGTERM', exitAltScreen);
  return {
    instance,
    cleanupResizeClear: () => {
      stdout.off('resize', clearBeforeResize);
      exitAltScreen();
      process.off('exit', exitAltScreen);
      process.off('SIGINT', exitAltScreen);
      process.off('SIGTERM', exitAltScreen);
    },
  };
}

function resolveStdout(options?: NodeJS.WriteStream | RenderOptions): NodeJS.WriteStream {
  if (!options) return process.stdout;
  if ('write' in options && !('stdout' in options)) return options as NodeJS.WriteStream;
  return ((options as RenderOptions).stdout as NodeJS.WriteStream | undefined) ?? process.stdout;
}
