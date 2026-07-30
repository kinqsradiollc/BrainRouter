import chalk, { type ChalkInstance } from 'chalk';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { getCliKnobs } from '@kinqs/brainrouter-core/config';

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
 *   - `dark`  — shared BrainRouter workbench spectrum on a neutral terminal
 *               canvas. Default.
 *   - `light` — darker accents + bolder weights so the palette stays
 *               legible on white terminals (solarized-light, GitHub light,
 *               Apple Terminal "Basic").
 *   - `mono`  — pure identity functions; no ANSI color, just text. For
 *               screenshot grabs, CI logs, and pipe-to-less.
 *
 * Selection order: `~/.config/brainrouter/config.json` `cli.theme` >
 * workspace preferences (`preferences.theme`) > `dark`. `auto` falls back
 * to `dark` for now — autodetecting light terminals from TTY hints is
 * unreliable enough that we leave it to the user to be explicit.
 *
 */

export type ThemeMode = 'dark' | 'light' | 'mono';

export interface ThemeColors {
  readonly primary?: string;
  readonly secondary?: string;
  readonly info?: string;
  readonly automation?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
}

export interface Theme {
  readonly mode: ThemeMode;
  /** Raw Ink-compatible colors for TUI components. Empty in byte-plain mono mode. */
  readonly colors: Readonly<ThemeColors>;
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
  const colors = {
    primary: '#8B7CFF',
    secondary: '#FF8B73',
    info: '#4DD8FF',
    automation: '#A3E635',
    success: '#22C55E',
    warning: '#EAB308',
    danger: '#EF4444',
  } as const;
  return {
    mode: 'dark',
    colors,
    primary: chalk.hex(colors.primary),
    secondary: chalk.hex(colors.secondary),
    success: chalk.hex(colors.success),
    warning: chalk.hex(colors.warning),
    danger: chalk.hex(colors.danger),
    info: chalk.hex(colors.info),
    muted: chalk.gray,
    dim: chalk.hex('#666666'),
    heading: chalk.bold.hex(colors.primary),
    plain: identity,
  };
}

function buildLight(): Theme {
  const colors = {
    primary: '#5D49C7',
    secondary: '#B3422E',
    info: '#006A80',
    automation: '#4D7100',
    success: '#137A2D',
    warning: '#7A5A00',
    danger: '#B4232E',
  } as const;
  return {
    mode: 'light',
    colors,
    // Darker counterparts preserve contrast on white terminal themes.
    primary: chalk.hex(colors.primary),
    secondary: chalk.hex(colors.secondary),
    success: chalk.hex(colors.success),
    warning: chalk.hex(colors.warning),
    danger: chalk.hex(colors.danger),
    info: chalk.hex(colors.info),
    muted: chalk.hex('#4A4A4A'),
    dim: chalk.hex('#7A7A7A'),
    heading: chalk.bold.hex(colors.primary),
    plain: identity,
  };
}

function buildMono(): Theme {
  return {
    mode: 'mono',
    colors: {},
    primary: identity,
    secondary: identity,
    success: identity,
    warning: identity,
    danger: identity,
    info: identity,
    muted: identity,
    dim: identity,
    heading: identity,
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
 * Resolve the active theme using config > preference > default precedence.
 * Pass `workspaceRoot` to honor a per-workspace `/theme` setting; omit to
 * resolve from config only (useful in test helpers where preferences
 * storage might not be initialized).
 */
export function resolveTheme(workspaceRoot?: string): Theme {
  // `cli.theme` from config.json. Default is 'auto', which we map to 'dark'.
  // A real explicit 'dark'/'light'/'mono' overrides workspace preferences.
  const cfgTheme = getCliKnobs().theme;
  if (cfgTheme === 'dark' || cfgTheme === 'light') return buildTheme(cfgTheme);
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
