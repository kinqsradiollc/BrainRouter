import readline from 'node:readline';
import { getActiveReadline, setActiveReadline } from '../../prompt/cliPrompt.js';

// --- Module-level shared state ----------------------------------------

let internalPickerActive = false;
export function isInternalPickerActive(): boolean { return internalPickerActive; }

// --- Frame runtime (atomic redraw + key plumbing) ---------------------

export interface FrameHandle {
  draw(text: string): void;
  onKey(handler: (key: any, str: string | undefined) => void): void;
  close(): void;
}

export interface FramedInputOptions {
  /**
   * When true (default), the frame is **erased** when the picker
   * closes — the cursor ends up where the frame started, so the next
   * print overwrites the same screen region. Every caller in the
   * wizard / `/config` / `/login` flows wants this behaviour:
   * pickers are modal, not transcript-y.
   *
   * Set to false explicitly to leave the frame on screen as
   * scrollback after close (the cursor lands one line below).
   * No current callers use this; reserved for future surfaces
   * (e.g. an `/agents` picker where the user wants the list to
   * stay visible).
   */
  eraseOnClose?: boolean;
}

/**
 * Owns stdin / cursor visibility / atomic redraw for the lifetime of a
 * single picker or prompt. The caller passes a function that returns a
 * Promise; we manage everything else.
 *
 * **Redraw math** — the source of the earlier "frame creeps upward
 * on every arrow key" bug.
 *
 * After writing a frame of M lines separated by M-1 newlines, the
 * cursor sits at the END of line M (NOT one line below). So to land
 * back at the START of line 1, we need to move up `M-1` lines, not
 * `M`. Earlier code used `text.split('\n').length` which is M, off by
 * one. We now track the newline count directly and use
 * `\x1b[<newlines>F` (move up + col 1, atomic). When newlines is 0
 * (single-line frame, edge case), we use `\r\x1b[K` to clear the
 * single line instead.
 */
export async function runFramedInput<T>(body: (frame: FrameHandle) => Promise<T>, opts: FramedInputOptions = {}): Promise<T> {
  const stdout = process.stdout;
  const ownsReadline = !getActiveReadline();
  let rl: readline.Interface | undefined;
  if (ownsReadline) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    setActiveReadline(rl);
  } else {
    rl = getActiveReadline()!;
    rl.pause();
  }
  readline.emitKeypressEvents(process.stdin);
  try { (process.stdin as any).setRawMode?.(true); } catch { /* not a real TTY */ }
  process.stdin.resume();
  stdout.write('\x1b[?25l');
  internalPickerActive = true;

  // Number of `\n` chars in the LAST frame we wrote. For an M-line
  // frame the count is M-1; that's exactly how many lines we need to
  // move the cursor up to land on the top row.
  let lastFrameNewlines = 0;
  let hasDrawn = false;
  let keyHandler: ((key: any, str: string | undefined) => void) | undefined;

  const eraseLastFrame = () => {
    if (!hasDrawn) return;
    if (lastFrameNewlines > 0) {
      // `\x1b[<n>F` = cursor up n lines AND col 1 (atomic). Then
      // `\x1b[J` erases from cursor to end of screen. After this the
      // cursor sits at the top-left of where the previous frame was.
      stdout.write(`\x1b[${lastFrameNewlines}F\x1b[J`);
    } else {
      // Single-line previous frame — just clear the current line in
      // place. `\r` to col 0, `\x1b[K` erase to end of line.
      stdout.write('\r\x1b[K');
    }
  };

  const draw = (text: string) => {
    eraseLastFrame();
    if (!hasDrawn) {
      // First draw — make sure we're at column 0 so the frame top
      // border doesn't sit mid-line.
      stdout.write('\r');
    }
    stdout.write(text);
    // Count newlines (NOT lines). `"a\nb\nc".match(/\n/g) → ['\n', '\n']`
    // → length 2; that's the correct cursor-up count.
    lastFrameNewlines = (text.match(/\n/g) ?? []).length;
    hasDrawn = true;
  };

  const onKeyInternal = (str: string | undefined, key: any) => {
    if (keyHandler) keyHandler(key ?? {}, str);
  };

  process.stdin.on('keypress', onKeyInternal);

  const cleanup = () => {
    process.stdin.removeListener('keypress', onKeyInternal);
    stdout.write('\x1b[?25h');
    if (opts.eraseOnClose !== false) {
      // Default — erase the last frame entirely so the next step's
      // frame (or post-picker print) starts at the same screen
      // position and visually replaces this one. Without this, each
      // step's cleanup would write `\n` and the next picker would
      // draw BELOW the previous one, accumulating frames down the
      // screen on every navigation.
      eraseLastFrame();
    } else {
      // Opt-out: leave the frame on screen as scrollback.
      stdout.write('\n');
    }
    internalPickerActive = false;
    if (ownsReadline && rl) {
      setActiveReadline(undefined);
      try { rl.close(); } catch { /* ignore */ }
    }
  };

  const handle: FrameHandle = {
    draw,
    onKey: (h) => { keyHandler = h; },
    close: cleanup,
  };

  try {
    const result = await body(handle);
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}
