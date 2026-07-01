/**
 * CUSTOMIZABLE KEYBOARD SHORTCUTS + editor template expansion (§5.9).
 *
 * A small, pure shortcut registry the desktop imports: the default bindings, a
 * chord ⇄ display-string codec, override resolution with conflict detection, and
 * keystroke → action matching. Plus `expandTemplates` — `{date}` / `{time}` style
 * tokens the editor expands on insert (the time source is injected, so the core
 * stays deterministic and CI-testable; the desktop passes a real `Date`).
 *
 * User overrides live in `cli.shortcuts` of config.json (action id → chord
 * string, e.g. {"save":"Cmd+S"}); the renderer resolves them through here.
 */

export interface KeyChord {
  /** The non-modifier key, normalized lowercase (e.g. 's', 'enter', '`'). */
  key: string;
  meta?: boolean;  // ⌘ / Win
  ctrl?: boolean;  // ⌃
  shift?: boolean; // ⇧
  alt?: boolean;   // ⌥
}

export interface ShortcutAction {
  id: string;
  label: string;
  defaultChord: KeyChord;
}

/** The built-in actions and their default bindings. */
export const DEFAULT_SHORTCUTS: ShortcutAction[] = [
  { id: 'save', label: 'Save', defaultChord: { key: 's', meta: true } },
  { id: 'command-palette', label: 'Command palette', defaultChord: { key: 'k', meta: true } },
  { id: 'toggle-diff', label: 'Toggle Changes panel', defaultChord: { key: 'd', meta: true, shift: true } },
  { id: 'toggle-files', label: 'Toggle Files panel', defaultChord: { key: 'f', meta: true, shift: true } },
  { id: 'toggle-terminal', label: 'Toggle terminal', defaultChord: { key: '`', ctrl: true } },
  { id: 'toggle-side-panel', label: 'Toggle side panel', defaultChord: { key: 'b', meta: true, alt: true } },
  { id: 'new-session', label: 'New session', defaultChord: { key: 'n', meta: true } },
  { id: 'search-session', label: 'Search session', defaultChord: { key: 'f', meta: true } },
  { id: 'plan-mode', label: 'Toggle plan mode', defaultChord: { key: 'p', meta: true, shift: true } },
];

const MOD_ORDER: Array<[keyof KeyChord, string]> = [
  ['ctrl', '⌃'],
  ['alt', '⌥'],
  ['shift', '⇧'],
  ['meta', '⌘'],
];

/** Normalize a key for stable comparison (lowercase; leave punctuation as-is). */
function normKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase().trim();
}

/** Named (non-printable) keys accepted as the chord's key beyond single chars. */
const NAMED_KEYS = new Set([
  'enter', 'tab', 'escape', 'esc', 'space', 'backspace', 'delete', 'del',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

function isValidKey(key: string): boolean {
  return key.length === 1 || NAMED_KEYS.has(key);
}

/** A canonical, order-independent signature for a chord (for equality + conflict checks). */
export function chordSignature(c: KeyChord): string {
  return `${c.meta ? 1 : 0}${c.ctrl ? 1 : 0}${c.shift ? 1 : 0}${c.alt ? 1 : 0}:${normKey(c.key)}`;
}

export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return chordSignature(a) === chordSignature(b);
}

/** Mac-style glyph display, e.g. `⇧⌘D`. */
export function chordToString(c: KeyChord): string {
  const mods = MOD_ORDER.filter(([k]) => c[k]).map(([, glyph]) => glyph).join('');
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key.replace(/^\w/, (m) => m.toUpperCase());
  return `${mods}${key}`;
}

/** Parse a human chord like `Shift+Cmd+D` / `⌃\`` / `Ctrl+K` into a {@link KeyChord}. */
export function parseChord(input: string): KeyChord | null {
  const raw = input.trim();
  if (!raw) return null;
  const chord: KeyChord = { key: '' };
  // `+`-separated form (`Cmd+K`); else a glyph run (`⇧⌘D`); else a single bare
  // token (`K`, or an invalid modifier-name like `Cmd`).
  const hasGlyphMod = /[⌘⌃⇧⌥]/.test(raw);
  const parts = raw.includes('+') ? raw.split('+') : hasGlyphMod ? Array.from(raw) : [raw];
  let sawInvalidKey = false;
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    const low = part.toLowerCase();
    if (low === 'cmd' || low === 'meta' || low === 'command' || part === '⌘') chord.meta = true;
    else if (low === 'ctrl' || low === 'control' || part === '⌃') chord.ctrl = true;
    else if (low === 'shift' || part === '⇧') chord.shift = true;
    else if (low === 'alt' || low === 'option' || low === 'opt' || part === '⌥') chord.alt = true;
    else {
      const k = normKey(part);
      if (isValidKey(k)) chord.key = k;
      else sawInvalidKey = true;
    }
  }
  return chord.key && !sawInvalidKey ? chord : null;
}

export interface ResolvedShortcuts {
  /** action id → effective chord (override if valid, else default). */
  bindings: Record<string, KeyChord>;
  /** Pairs of action ids that resolved to the same chord. */
  conflicts: Array<[string, string]>;
}

/**
 * Merge user overrides (action id → chord string) over the defaults, dropping
 * unparseable / unknown overrides, and report any two actions that collide.
 */
export function resolveShortcuts(
  overrides: Record<string, string> = {},
  actions: ShortcutAction[] = DEFAULT_SHORTCUTS,
): ResolvedShortcuts {
  const bindings: Record<string, KeyChord> = {};
  for (const a of actions) {
    const override = overrides[a.id];
    const parsed = typeof override === 'string' ? parseChord(override) : null;
    bindings[a.id] = parsed ?? a.defaultChord;
  }
  const conflicts: Array<[string, string]> = [];
  const ids = Object.keys(bindings);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (chordSignature(bindings[ids[i]]) === chordSignature(bindings[ids[j]])) conflicts.push([ids[i], ids[j]]);
    }
  }
  return { bindings, conflicts };
}

/** The action id whose binding matches a pressed chord, or null. First match wins. */
export function matchChord(pressed: KeyChord, bindings: Record<string, KeyChord>): string | null {
  const sig = chordSignature(pressed);
  for (const [id, chord] of Object.entries(bindings)) {
    if (chordSignature(chord) === sig) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// editor template expansion — {date} / {time} / {datetime} / {iso}
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Expand `{date}` / `{time}` / `{datetime}` / `{iso}` tokens against an injected
 * clock (deterministic — the desktop passes `new Date()`). Unknown tokens are
 * left untouched; `{{` / `}}` escape a literal brace.
 */
export function expandTemplates(text: string, now: Date): string {
  const y = now.getFullYear(), mo = pad(now.getMonth() + 1), d = pad(now.getDate());
  const h = pad(now.getHours()), mi = pad(now.getMinutes());
  const date = `${y}-${mo}-${d}`;
  const time = `${h}:${mi}`;
  const map: Record<string, string> = {
    date,
    time,
    datetime: `${date} ${time}`,
    iso: now.toISOString(),
  };
  // single pass: `{{`/`}}` escape a literal brace; `{token}` expands; else verbatim.
  return text.replace(/\{\{|\}\}|\{(date|time|datetime|iso)\}/g, (m, token: string | undefined) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    return map[token as string];
  });
}
