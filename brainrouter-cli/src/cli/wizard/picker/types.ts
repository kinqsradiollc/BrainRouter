import { type Theme } from '../../theme.js';

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
 *      picker splices into its own frame. (Preview never writes; the
 *      redraw owns the change.)
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
   * to stdout.
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
