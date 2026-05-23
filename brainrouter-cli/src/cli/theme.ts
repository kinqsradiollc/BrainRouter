import chalk, { type ChalkInstance } from 'chalk';
import { readPreferences } from '../state/preferencesStore.js';

/**
 * Consolidated terminal theme tokens.
 *
 * Before this module, chalk hex/named colors were sprinkled across every
 * command file — `chalk.hex('#CC9166')` here, `chalk.green` there. Two
 * problems with that: (1) the orange that worked beautifully on a black
 * terminal washed out on a light terminal so users on solarized-light
 * couldn't read the prompt at all; (2) any "let's tone down the chrome"
 * pass required grepping the entire CLI for chalk calls.
 *
 * The fix is a single source of truth. Every visible surface that needs
 * color reaches for a SEMANTIC token (primary, success, danger, …) instead
 * of a raw chalk call. Three palettes ship in-tree:
 *
 *   - `dark`  — original Midnight Ledger / Obsidian Surface (matches what
 *               the CLI has rendered since 0.3.x). Default.
 *   - `light` — darker accents + bolder weights so the palette stays
 *               legible on white terminals (solarized-light, GitHub light,
 *               Apple Terminal "Basic").
 *   - `mono`  — pure identity functions; no ANSI color, just text. For
 *               screenshot grabs, CI logs, and pipe-to-less.
 *
 * Selection order: `BRAINROUTER_THEME` env var > workspace preferences
 * (`preferences.theme`) > `dark`. `auto` falls back to `dark` for now —
 * autodetecting light terminals from TTY hints is unreliable enough that
 * we leave it to the user to be explicit.
 *
 * Inspired by DeepSeek-TUI's `palette.rs` (see openSrc/DeepSeek-TUI/crates/tui/src/palette.rs),
 * which centralizes its terminal color tokens for the same reason.
 */

export type ThemeMode = 'dark' | 'light' | 'mono';

export interface Theme {
  readonly mode: ThemeMode;
  /** Brand accent — used for the banner header, "brainrouter>" prompt, key callouts. */
  readonly primary: ChalkInstance;
  /** Secondary accent — supporting brand color (e.g. agent role tags). */
  readonly secondary: ChalkInstance;
  /** Successful operation (✓ tool completed, ✔ saved). */
  readonly success: ChalkInstance;
  /** Recoverable warning (offline mode, missing config). */
  readonly warning: ChalkInstance;
  /** Failure or destructive action (✗ tool failed, dangerous shell). */
  readonly danger: ChalkInstance;
  /** Neutral informational hint (cyan-ish in the dark palette). */
  readonly info: ChalkInstance;
  /** De-emphasized body text — most chrome lives here. */
  readonly muted: ChalkInstance;
  /** Maximally de-emphasized — borders, separators, "less important than muted". */
  readonly dim: ChalkInstance;
  /** Bold heading text (banner title, /help category headers). */
  readonly heading: ChalkInstance;
  /** Identity — no styling. Used for verbatim payloads where ANSI would corrupt copy/paste. */
  readonly plain: ChalkInstance;
}

const identity = ((s: string) => s) as unknown as ChalkInstance;

function buildDark(): Theme {
  return {
    mode: 'dark',
    primary: chalk.hex('#CC9166'),
    secondary: chalk.magenta,
    success: chalk.green,
    warning: chalk.yellow,
    danger: chalk.red,
    info: chalk.cyan,
    muted: chalk.gray,
    dim: chalk.hex('#666666'),
    heading: chalk.bold.hex('#CC9166'),
    plain: identity,
  };
}

function buildLight(): Theme {
  return {
    mode: 'light',
    // Saturated orange-brown — still readable on white because chalk emits
    // a TrueColor sequence the terminal renders as-is.
    primary: chalk.hex('#A24E1F'),
    secondary: chalk.hex('#7B2CBF'),
    success: chalk.hex('#0F7B3E'),
    warning: chalk.hex('#8A6300'),
    danger: chalk.hex('#A4161A'),
    info: chalk.hex('#005F8C'),
    muted: chalk.hex('#4A4A4A'),
    dim: chalk.hex('#7A7A7A'),
    heading: chalk.bold.hex('#A24E1F'),
    plain: identity,
  };
}

function buildMono(): Theme {
  return {
    mode: 'mono',
    primary: identity,
    secondary: identity,
    success: identity,
    warning: identity,
    danger: identity,
    info: identity,
    muted: identity,
    dim: identity,
    heading: chalk.bold,
    plain: identity,
  };
}

function normalizeMode(raw: string | undefined): ThemeMode | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'dark' || v === 'light' || v === 'mono') return v;
  if (v === 'auto') return 'dark';
  return undefined;
}

export function buildTheme(mode: ThemeMode): Theme {
  if (mode === 'light') return buildLight();
  if (mode === 'mono') return buildMono();
  return buildDark();
}

/**
 * Resolve the active theme using env-var > preference > default precedence.
 * Pass `workspaceRoot` to honor a per-workspace `/theme` setting; omit to
 * resolve from env only (useful in test helpers where preferences storage
 * might not be initialized).
 */
export function resolveTheme(workspaceRoot?: string): Theme {
  const envMode = normalizeMode(process.env.BRAINROUTER_THEME);
  if (envMode) return buildTheme(envMode);
  if (workspaceRoot) {
    try {
      const prefs = readPreferences(workspaceRoot);
      const prefMode = normalizeMode(prefs.theme);
      if (prefMode) return buildTheme(prefMode);
    } catch {
      // preferences file unreadable — fall through to default.
    }
  }
  return buildTheme('dark');
}

/**
 * Box-drawing characters for the startup banner and /where view. Centralized
 * so a future ASCII-only fallback (for terminals that mangle UTF-8 box chars)
 * is one switch instead of a sweep through render code.
 */
export const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  midLeft: '├',
  midRight: '┤',
  cross: '┼',
} as const;
