/**
 * §shortcuts — the single source of truth for the app's keyboard shortcuts.
 *
 * Combos are stored in a NEUTRAL form (`Mod+Shift+D`, `Ctrl+Backtick`, …) where
 * `Mod` = ⌘ on macOS / Ctrl elsewhere. A per-OS formatter renders them so the
 * UI shows the right glyphs for the user's keyboard (the handlers already match
 * cross-platform via `metaKey || ctrlKey`). This registry powers BOTH the inline
 * hint chips and the searchable reference in Advanced settings, so they never
 * drift; B2 (rebindable) layers user overrides on top of these defaults.
 */
import { useMemo } from 'react';

export type OS = 'mac' | 'windows' | 'linux';

export type ShortcutArea = 'Navigation' | 'Panels' | 'Session' | 'Composer' | 'Editor';

export interface ShortcutDef {
  /** Stable id (also the key for a user override in B2). */
  id: string;
  /** Neutral combo, '+'-joined: tokens Mod | Ctrl | Shift | Alt | <key>. */
  combo: string;
  /** Human-readable action. */
  action: string;
  area: ShortcutArea;
}

/** The default keybindings, grouped by area (order = display order). */
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'palette', combo: 'Mod+K', action: 'Open command palette', area: 'Navigation' },
  { id: 'settings', combo: 'Mod+,', action: 'Open settings', area: 'Navigation' },

  { id: 'panel-files', combo: 'Mod+P', action: 'Toggle Files panel', area: 'Panels' },
  { id: 'panel-files-alt', combo: 'Mod+Shift+F', action: 'Toggle Files panel', area: 'Panels' },
  { id: 'panel-diff', combo: 'Mod+Shift+D', action: 'Toggle Changes panel', area: 'Panels' },
  { id: 'panel-plan', combo: 'Mod+Shift+G', action: 'Toggle Plan panel', area: 'Panels' },
  { id: 'panel-fullscreen', combo: 'Mod+Shift+E', action: 'Fullscreen the side panel', area: 'Panels' },
  { id: 'terminal', combo: 'Ctrl+Backtick', action: 'Toggle the terminal dock', area: 'Panels' },
  { id: 'panel-close', combo: 'Escape', action: 'Close the panel drawer', area: 'Panels' },

  { id: 'session-jump', combo: 'Mod+1…9', action: 'Jump to recent session 1–9', area: 'Session' },

  { id: 'mode-menu', combo: 'Mod+Shift+M', action: 'Open the mode menu', area: 'Composer' },
  { id: 'model-menu', combo: 'Mod+Shift+I', action: 'Open the model menu', area: 'Composer' },
  { id: 'send', combo: 'Enter', action: 'Send the message', area: 'Composer' },
  { id: 'newline', combo: 'Shift+Enter', action: 'Insert a newline', area: 'Composer' },
  { id: 'stop', combo: 'Escape', action: 'Stop the running turn', area: 'Composer' },

  { id: 'editor-save', combo: 'Mod+S', action: 'Save the file', area: 'Editor' },
  { id: 'editor-find', combo: 'Mod+F', action: 'Find in the file', area: 'Editor' },
  { id: 'editor-outline', combo: 'Mod+Shift+O', action: 'Quick outline', area: 'Editor' },
];

export const SHORTCUT_AREAS: ShortcutArea[] = ['Navigation', 'Panels', 'Session', 'Composer', 'Editor'];

/** Detect the host OS from the renderer (no preload round-trip needed). */
export function detectOS(): OS {
  const s = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return 'mac';
  if (/Win/i.test(s)) return 'windows';
  return 'linux';
}

/** Render a single combo token to its per-OS label. */
function formatToken(token: string, isMac: boolean): string {
  switch (token) {
    case 'Mod': return isMac ? '⌘' : 'Ctrl';
    case 'Ctrl': return isMac ? '⌃' : 'Ctrl';
    case 'Shift': return isMac ? '⇧' : 'Shift';
    case 'Alt': return isMac ? '⌥' : 'Alt';
    case 'Enter': return '↵';
    case 'Escape': return 'Esc';
    case 'Backtick': return '`';
    default: return token; // a literal key, e.g. 'K', ',', '1…9'
  }
}

/** Format a neutral combo for display on `os` (⌘⇧D on mac, Ctrl+Shift+D else). */
export function formatCombo(combo: string, os: OS): string {
  const isMac = os === 'mac';
  const parts = combo.split('+').map((t) => formatToken(t, isMac));
  return parts.join(isMac ? '' : '+');
}

/** Renderer hook: the detected OS + a memoised `fmt(combo)` helper. */
export function usePlatform(): { os: OS; isMac: boolean; fmt: (combo: string) => string } {
  return useMemo(() => {
    const os = detectOS();
    return { os, isMac: os === 'mac', fmt: (combo: string) => formatCombo(combo, os) };
  }, []);
}

// ===========================================================================
// §5.9 — customizable shortcuts: capture a keystroke → neutral combo, and apply
// user overrides (stored in cli.shortcuts as { id: combo }) over the defaults.
// ===========================================================================

/** A pressed key normalized to a neutral combo token (matches the SHORTCUTS form). */
function normalizeKey(key: string): string {
  if (key === '`') return 'Backtick';
  if (key === ' ') return 'Space';
  if (key === 'Escape' || key === 'Enter' || key === 'Tab' || key === 'Backspace' || key === 'Delete') return key;
  if (key.startsWith('Arrow')) return key.slice(5); // ArrowUp → Up
  return key.length === 1 ? key.toUpperCase() : key;
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt']);

export interface CaptureEvent { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }

/**
 * Turn a keydown into a neutral combo (`Mod+Shift+D`, `Ctrl+Backtick`), or null
 * if only modifiers are held. `Mod` is the platform's primary accelerator (⌘ on
 * mac, Ctrl elsewhere); a literal Ctrl on mac stays `Ctrl` (so e.g. Ctrl+Backtick
 * round-trips). The token order is fixed: Mod, Ctrl, Shift, Alt, key.
 */
export function captureCombo(e: CaptureEvent, os: OS = detectOS()): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const isMac = os === 'mac';
  const tokens: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) tokens.push('Mod');
  if (isMac && e.ctrlKey) tokens.push('Ctrl'); // literal Ctrl on mac (distinct from ⌘)
  if (e.shiftKey) tokens.push('Shift');
  if (e.altKey) tokens.push('Alt');
  tokens.push(normalizeKey(e.key));
  return tokens.join('+');
}

export interface ResolvedShortcuts {
  /** SHORTCUTS with any user override applied to `combo`. */
  shortcuts: ShortcutDef[];
  /** Pairs of shortcut ids that, after overrides, collide WITHIN the same area. */
  conflicts: Array<[string, string]>;
}

/**
 * Apply user overrides (id → neutral combo) over the built-in {@link SHORTCUTS}
 * and report any within-area collisions. Cross-area duplicates (e.g. `Escape`
 * for both "close panel" and "stop turn") are intentional and not flagged.
 */
export function resolveShortcutOverrides(overrides: Record<string, string> = {}): ResolvedShortcuts {
  const shortcuts = SHORTCUTS.map((s) => {
    const ov = overrides[s.id];
    return ov && ov.trim() ? { ...s, combo: ov.trim() } : s;
  });
  const conflicts: Array<[string, string]> = [];
  for (let i = 0; i < shortcuts.length; i++) {
    for (let j = i + 1; j < shortcuts.length; j++) {
      if (shortcuts[i].area === shortcuts[j].area && shortcuts[i].combo === shortcuts[j].combo) {
        conflicts.push([shortcuts[i].id, shortcuts[j].id]);
      }
    }
  }
  return { shortcuts, conflicts };
}
