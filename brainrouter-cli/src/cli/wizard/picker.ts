import readline from 'node:readline';
import chalk from 'chalk';
import { getActiveReadline, setActiveReadline } from '../cliPrompt.js';
import { buildTheme, type Theme, type ThemeMode } from '../theme.js';

/**
 * Internal picker primitive — purpose-built for the wizard / `/config` /
 * `/login` flows.
 *
 * Distinct from `cliPrompt.ts:askChoice` (which backs the LLM-callable
 * `ask_user_choice` tool and is intentionally constrained: 2–4 options,
 * always-on synthetic "Other" row, error envelopes for the agent). This
 * picker has no LLM-tool constraints — N options, optional "Other" row,
 * optional free-text input, optional live-preview callback that returns
 * preview ROWS (rendered INSIDE the picker's frame) instead of writing
 * to stdout.
 *
 * Render contract (atomic frame):
 *
 *   1. Caller passes ALL chrome (title, subtitle, options, footer hint)
 *      as fields on `PickerView`. The picker computes the full frame
 *      string in one pass and writes it with one `stdout.write`.
 *   2. The picker owns its rendered region for its lifetime. NO call
 *      site may write to stdout while the picker is active — preview
 *      lines are returned from `onCursorChange` as a string[] that the
 *      picker splices into its own frame. (Pattern lifted from
 *      `openSrc/codex/codex-rs/tui/src/theme_picker.rs` — preview never
 *      writes; the redraw owns the change.)
 *   3. Redraw uses `\x1b[<N>F` (cursor up + col 0) + `\x1b[J` (erase to
 *      end of screen) to nuke the previous frame, then writes the new
 *      one. No `text + '\n'` off-by-one because we count the actual
 *      lines we'll write.
 *
 * Why a separate file (not just an extension of `cliPrompt.ts`)? The
 * LLM-tool contract for `ask_user_choice` is explicit ("2-4 options
 * with mutually exclusive labels, always an Other fallback"), and
 * widening it would weaken the constraint the system prompt teaches
 * the model to follow. Internal CLI flows have different requirements
 * (7 providers in a list, no "Other" for theme picker, free-text-only
 * for API-key entry). Keep them in separate primitives.
 */

// --- Public types ------------------------------------------------------

export interface PickerRow {
  /** Stable id used in the resolved result. */
  id: string;
  /** Human-readable left-aligned label. */
  label: string;
  /** Right-aligned value column (current setting, hint text, status). Optional. */
  value?: string;
  /** Sub-line shown muted under the label. Optional. */
  description?: string;
  /** When true, the row is shown but not selectable (separator-like). */
  disabled?: boolean;
}

export interface PickFromListOptions {
  /** Bold title rendered at the top of the frame (e.g. "Theme"). */
  title: string;
  /** Muted subtitle under the title (e.g. "Pick a color palette."). Optional. */
  subtitle?: string;
  /** Right-side chip in the title bar (e.g. "Step 1 of 6"). Optional. */
  badge?: string;
  /** Footer hint line (e.g. "↑/↓ navigate · ENTER confirm · q to cancel"). Defaults are sensible. */
  footer?: string;
  /** Picker rows. No upper limit; height clamps automatically. */
  rows: PickerRow[];
  /** Initial cursor index. Clamped to [0, rows.length - 1]. */
  initialCursor?: number;
  /** When true, an "Other" row is appended that drops to free-text entry. */
  allowOther?: boolean;
  /** Label for the appended Other row (default: "Other"). */
  otherLabel?: string;
  /** Description for the Other row. */
  otherDescription?: string;
  /** Pre-fill the Other free-text buffer. Used by env-var-derived defaults. */
  prefilledOther?: string;
  /**
   * Live-preview hook. Fires after a real cursor move only. Returns an
   * array of preview lines to render INSIDE the picker frame (above the
   * footer). Returning `undefined` or `[]` means "no preview".
   *
   * The picker takes care of the redraw — the callback must NOT write
   * to stdout. Mirrors `openSrc/codex/codex-rs/tui/src/theme_picker.rs`
   * (preview returns a row spec, never `stdout.write`).
   */
  onCursorChange?: (cursorId: string, cursorIndex: number) => string[] | undefined;
  /** Theme for chrome coloring; defaults to `dark`. */
  theme?: Theme;
  /**
   * When true, the frame is erased on close so the next picker (or
   * print) lands at the same screen position. Wizard sets this so
   * each step REPLACES the previous frame instead of stacking
   * downward on screen.
   */
  eraseOnClose?: boolean;
}

export type PickFromListResult =
  | { kind: 'pick'; id: string }
  | { kind: 'other'; text: string }
  | { kind: 'cancelled' };

/**
 * Free-text-only entry. Used by the wizard's API-key step.
 *
 * Renders a single masked input row inside a framed panel. Same redraw
 * contract as `pickFromList` — atomic frames, owns its region.
 */
export interface PromptTextOptions {
  title: string;
  subtitle?: string;
  badge?: string;
  /** Right-side chip in the title bar (e.g. "openai · cloud"). */
  /** Pre-filled buffer (e.g. value from env). ENTER accepts as-is. */
  prefilled?: string;
  /** When true, render input as `·······abcd` (mask all but last 4). */
  mask?: boolean;
  /** Placeholder shown muted when the input is empty. */
  placeholder?: string;
  /** Footer hint. */
  footer?: string;
  /** Optional validator. Return undefined to accept; return string to show as an inline error. */
  validate?: (raw: string) => string | undefined;
  /** Theme for chrome coloring. */
  theme?: Theme;
  /** See PickFromListOptions.eraseOnClose. */
  eraseOnClose?: boolean;
}

export type PromptTextResult =
  | { kind: 'accept'; text: string }
  | { kind: 'cancelled' };

// --- Module-level shared state ----------------------------------------

let internalPickerActive = false;
export function isInternalPickerActive(): boolean { return internalPickerActive; }

// --- Frame renderer ----------------------------------------------------

interface FrameInputs {
  theme: Theme;
  title: string;
  subtitle?: string;
  badge?: string;
  bodyLines: string[];
  previewLines?: string[];
  footer: string;
  width: number;
}

/**
 * Compute the full picker frame as a single string. Pure function so
 * tests can assert on the exact output without driving a TTY.
 *
 * Layout (single column for now — wide-terminal two-column comes in a
 * follow-up):
 *
 *   ┌─ <title> ─────────────────────── <badge> ─┐
 *   │ <subtitle>                                │
 *   │                                           │
 *   │ <body line 1>                             │
 *   │ <body line 2>                             │
 *   │ ...                                       │
 *   │                                           │  (preview block if present)
 *   │ <preview line 1>                          │
 *   │ <preview line 2>                          │
 *   │                                           │
 *   │ <footer>                                  │
 *   └───────────────────────────────────────────┘
 */
export function renderFrame(f: FrameInputs): string {
  const t = f.theme;
  const W = f.width;
  // Inner content width: W minus 2 border cols minus 2 padding cols.
  const inner = Math.max(20, W - 4);

  const top = renderTopBorder(t, f.title, f.badge, W);
  const lines: string[] = [top];

  if (f.subtitle) {
    for (const wrapped of wrap(f.subtitle, inner)) {
      lines.push(t.primary('│') + ' ' + t.muted(padRight(wrapped, inner)) + ' ' + t.primary('│'));
    }
    lines.push(blank(t, W));
  }

  for (const raw of f.bodyLines) {
    // Wrap is opt-out for body — the picker pre-formats option rows with
    // exact widths, so let those pass through verbatim.
    lines.push(t.primary('│') + ' ' + padRightVisible(raw, inner) + ' ' + t.primary('│'));
  }

  if (f.previewLines && f.previewLines.length > 0) {
    lines.push(divider(t, W));
    for (const raw of f.previewLines) {
      lines.push(t.primary('│') + ' ' + padRightVisible(raw, inner) + ' ' + t.primary('│'));
    }
  }

  lines.push(blank(t, W));
  lines.push(t.primary('│') + ' ' + padRightVisible(t.muted(f.footer), inner) + ' ' + t.primary('│'));
  lines.push(t.primary('└' + '─'.repeat(W - 2) + '┘'));

  return lines.join('\n');
}

function renderTopBorder(t: Theme, title: string, badge: string | undefined, W: number): string {
  const titleText = ` ${t.heading(title)} `;
  const badgeText = badge ? ` ${t.muted(badge)} ` : '';
  const titleWidth = visibleLength(titleText);
  const badgeWidth = visibleLength(badgeText);
  const dashWidth = Math.max(2, W - 2 - titleWidth - badgeWidth);
  return (
    t.primary('┌─') + titleText
    + t.primary('─'.repeat(dashWidth))
    + badgeText
    + t.primary('┐')
  );
}

function blank(t: Theme, W: number): string {
  return t.primary('│') + ' '.repeat(W - 2) + t.primary('│');
}
function divider(t: Theme, W: number): string {
  // Subtle in-frame separator — single dim line, no chars.
  return t.primary('├') + t.dim('─'.repeat(W - 2)) + t.primary('┤');
}

function padRight(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

/** ANSI-aware right-pad. Strips ANSI sequences when counting width. */
function padRightVisible(s: string, w: number): string {
  const v = visibleLength(s);
  if (v >= w) return clipVisible(s, w);
  return s + ' '.repeat(w - v);
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
function clipVisible(s: string, w: number): string {
  // Naive ANSI-aware clip — used only for badge / overflow protection.
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end < 0) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += s[i];
    i++;
    visible++;
  }
  return out;
}

/** Simple word-wrap; doesn't try to be ANSI-aware (subtitle takes plain text). */
function wrap(s: string, w: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= w) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

// --- Body row formatting ----------------------------------------------

interface FormattedRow {
  selected: boolean;
  text: string;
  description?: string;
}

function formatBodyRow(t: Theme, row: PickerRow, isSelected: boolean, valueColWidth: number, inner: number): string[] {
  // Selected glyph: `›` lifted from openSrc/grok-cli/src/ui/components/SuggestionOverlay.tsx
  // (we use ▶ in the LLM-tool picker; switch to › for the internal picker
  // because it reads cleaner against the chalk gray + bold combo).
  const marker = isSelected ? t.primary('›') : ' ';
  const labelFg = row.disabled ? t.dim : isSelected ? t.heading : t.plain;
  const valueFg = isSelected ? t.muted : t.dim;
  const label = labelFg(row.label);
  const value = row.value ? valueFg(row.value) : '';
  // Layout: " › LABEL ...VALUE"   with value right-aligned.
  const leftPart = ' ' + marker + ' ' + label;
  const leftVisible = visibleLength(leftPart);
  const valueVisible = visibleLength(value);
  const gapWidth = Math.max(2, inner - leftVisible - valueVisible);
  const line = leftPart + ' '.repeat(gapWidth) + value;
  const lines = [line];
  if (row.description) {
    const INDENT = '     '; // 5 spaces — aligns under "› LABEL"
    // Wrap the bare description (no indent) to the inner width MINUS
    // the indent so the indented line stays inside the frame. Then
    // re-indent each wrapped line and apply the dim color uniformly.
    const wrapped = wrap(row.description, Math.max(8, inner - INDENT.length));
    for (const w of wrapped) {
      lines.push(INDENT + t.dim(w));
    }
  }
  return lines;
}

// --- pickFromList ------------------------------------------------------

export async function pickFromList(opts: PickFromListOptions): Promise<PickFromListResult> {
  return runFramedInput(async (frame) => {
    const theme = opts.theme ?? buildTheme('dark');
    const augmentedRows: PickerRow[] = opts.allowOther
      ? [
          ...opts.rows,
          {
            id: '__other__',
            label: opts.otherLabel ?? 'Other',
            description: opts.otherDescription ?? 'Type a free-form answer',
          },
        ]
      : [...opts.rows];

    let cursor = clamp(opts.initialCursor ?? 0, 0, augmentedRows.length - 1);
    let phase: 'pick' | 'other' = opts.prefilledOther !== undefined ? 'other' : 'pick';
    let otherText = opts.prefilledOther ?? '';
    let previewLines: string[] | undefined;

    // Initial preview if a row is selected on entry.
    const fireCursorChange = () => {
      if (opts.onCursorChange && phase === 'pick') {
        const row = augmentedRows[cursor];
        if (row && row.id !== '__other__') {
          try { previewLines = opts.onCursorChange(row.id, cursor); } catch { previewLines = undefined; }
        } else {
          previewLines = undefined;
        }
      }
    };
    fireCursorChange();

    const computeFrame = (): string => {
      const W = computeWidth(opts.title, augmentedRows, theme);
      const inner = Math.max(20, W - 4);
      const bodyLines: string[] = [];
      if (phase === 'pick') {
        const valueColWidth = computeValueColumn(augmentedRows);
        for (let i = 0; i < augmentedRows.length; i++) {
          const row = augmentedRows[i];
          const formatted = formatBodyRow(theme, row, i === cursor, valueColWidth, inner);
          bodyLines.push(...formatted);
        }
      } else {
        // Free-text "Other" phase.
        bodyLines.push(' ' + theme.muted('›') + ' ' + theme.heading('Type your answer'));
        bodyLines.push('     ' + theme.dim(opts.otherDescription ?? 'Press ENTER to accept · Esc to go back'));
        bodyLines.push('');
        const display = otherText.length > 0 ? otherText : theme.dim('(empty)');
        bodyLines.push('   ' + theme.info('›') + ' ' + display + theme.muted('_'));
      }
      const footer = opts.footer ?? defaultFooter(phase, !!opts.allowOther);
      return renderFrame({
        theme,
        title: opts.title,
        subtitle: opts.subtitle,
        badge: opts.badge,
        bodyLines,
        previewLines,
        footer,
        width: W,
      });
    };

    return new Promise<PickFromListResult>((resolve) => {
      frame.draw(computeFrame());

      frame.onKey((key, str) => {
        if (key.ctrl && (key.name === 'c' || key.sequence === '')) {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }

        if (phase === 'other') {
          if (key.name === 'return') {
            const trimmed = otherText.trim();
            if (!trimmed) return; // require non-empty
            frame.close();
            resolve({ kind: 'other', text: trimmed });
            return;
          }
          if (key.name === 'escape') {
            phase = 'pick';
            otherText = '';
            fireCursorChange();
            frame.draw(computeFrame());
            return;
          }
          if (key.name === 'backspace') {
            if (otherText.length > 0) {
              otherText = otherText.slice(0, -1);
              frame.draw(computeFrame());
            }
            return;
          }
          if (typeof str === 'string' && str.length === 1 && !key.ctrl && key.name !== 'tab') {
            otherText += str;
            frame.draw(computeFrame());
            return;
          }
          return;
        }

        // pick phase
        if (key.name === 'up' || (key.name === 'k' && !key.ctrl && !key.meta)) {
          cursor = (cursor - 1 + augmentedRows.length) % augmentedRows.length;
          while (augmentedRows[cursor].disabled) cursor = (cursor - 1 + augmentedRows.length) % augmentedRows.length;
          fireCursorChange();
          frame.draw(computeFrame());
          return;
        }
        if (key.name === 'down' || (key.name === 'j' && !key.ctrl && !key.meta)) {
          cursor = (cursor + 1) % augmentedRows.length;
          while (augmentedRows[cursor].disabled) cursor = (cursor + 1) % augmentedRows.length;
          fireCursorChange();
          frame.draw(computeFrame());
          return;
        }
        if (key.name === 'return') {
          const row = augmentedRows[cursor];
          if (row.disabled) return;
          if (row.id === '__other__') {
            phase = 'other';
            previewLines = undefined;
            frame.draw(computeFrame());
            return;
          }
          frame.close();
          resolve({ kind: 'pick', id: row.id });
          return;
        }
        if (key.name === 'escape' || key.name === 'q') {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
      });
    });
  }, { eraseOnClose: opts.eraseOnClose });
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function computeValueColumn(rows: PickerRow[]): number {
  let max = 0;
  for (const row of rows) if (row.value) max = Math.max(max, visibleLength(row.value));
  return max;
}

function computeWidth(title: string, rows: PickerRow[], _theme: Theme): number {
  const terminal = (process.stdout.columns ?? 80);
  const target = 76;
  const min = 56;
  const max = Math.max(min, Math.min(terminal - 4, 100));
  let widest = visibleLength(title) + 12; // title + badge slack
  for (const row of rows) {
    const valueW = row.value ? visibleLength(row.value) : 0;
    const labelW = visibleLength(row.label);
    widest = Math.max(widest, labelW + 6 + valueW); // gap + glyph
    if (row.description) widest = Math.max(widest, visibleLength(row.description) + 6);
  }
  return clamp(Math.max(widest + 4, target), min, max);
}

function defaultFooter(phase: 'pick' | 'other', allowOther: boolean): string {
  if (phase === 'other') {
    return '↵ accept  ·  esc back  ·  ⌫ erase';
  }
  return allowOther
    ? '↑/↓ navigate  ·  ↵ confirm  ·  esc / q cancel'
    : '↑/↓ navigate  ·  ↵ confirm  ·  esc / q cancel';
}

// --- promptText --------------------------------------------------------

export async function promptText(opts: PromptTextOptions): Promise<PromptTextResult> {
  return runFramedInput(async (frame) => {
    const theme = opts.theme ?? buildTheme('dark');
    let text = opts.prefilled ?? '';
    let error: string | undefined;

    const computeFrame = (): string => {
      const W = Math.max(60, Math.min((process.stdout.columns ?? 80) - 4, 90));
      const inner = Math.max(20, W - 4);
      const bodyLines: string[] = [];
      const visibleText = text.length === 0
        ? theme.dim(opts.placeholder ?? '(type here)')
        : opts.mask ? maskInput(text) : text;
      bodyLines.push('   ' + theme.info('›') + ' ' + visibleText + theme.muted('_'));
      if (error) {
        bodyLines.push('');
        bodyLines.push('   ' + theme.danger('✗ ' + error));
      }
      return renderFrame({
        theme,
        title: opts.title,
        subtitle: opts.subtitle,
        badge: opts.badge,
        bodyLines,
        footer: opts.footer ?? '↵ accept  ·  esc cancel  ·  ⌫ erase',
        width: W,
      });
    };

    return new Promise<PromptTextResult>((resolve) => {
      frame.draw(computeFrame());

      frame.onKey((key, str) => {
        if (key.ctrl && (key.name === 'c' || key.sequence === '')) {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
        if (key.name === 'escape') {
          frame.close();
          resolve({ kind: 'cancelled' });
          return;
        }
        if (key.name === 'return') {
          const validate = opts.validate;
          if (validate) {
            const verdict = validate(text);
            if (verdict !== undefined) {
              error = verdict;
              frame.draw(computeFrame());
              return;
            }
          }
          frame.close();
          resolve({ kind: 'accept', text });
          return;
        }
        if (key.name === 'backspace') {
          if (text.length > 0) {
            text = text.slice(0, -1);
            error = undefined;
            frame.draw(computeFrame());
          }
          return;
        }
        if (typeof str === 'string' && str.length === 1 && !key.ctrl && key.name !== 'tab') {
          text += str;
          error = undefined;
          frame.draw(computeFrame());
          return;
        }
      });
    });
  }, { eraseOnClose: opts.eraseOnClose });
}

function maskInput(s: string): string {
  if (s.length <= 4) return '·'.repeat(s.length);
  return '·'.repeat(Math.max(4, s.length - 4)) + s.slice(-4);
}

// --- Frame runtime (atomic redraw + key plumbing) ---------------------

interface FrameHandle {
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
async function runFramedInput<T>(body: (frame: FrameHandle) => Promise<T>, opts: FramedInputOptions = {}): Promise<T> {
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

// --- Surface re-exports for tests + callers ---------------------------

/** Pure helpers exposed for unit tests. */
export const __test = {
  renderFrame,
  formatBodyRow,
  visibleLength,
  stripAnsi,
  wrap,
  padRightVisible,
  computeValueColumn,
  defaultFooter,
};
