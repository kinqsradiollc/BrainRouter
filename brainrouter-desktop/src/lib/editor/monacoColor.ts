/**
 * Pure color helpers for the Monaco theme. Kept free of the `monaco-editor` (and
 * Vite `?worker`) imports in monacoEnv.ts so they're unit-testable in plain node.
 *
 * Monaco's theme parser only accepts hex — `editor.foreground`/`background` flow
 * into the token theme and THROW "Illegal value for token color" on anything
 * else. Our palette (theme.css) is authored in hsl/rgb, so each value is
 * canvas-normalized in monacoEnv and finished into hex here.
 */

/** True for #rgb / #rgba / #rrggbb / #rrggbbaa — values Monaco parses directly. */
export function isMonacoHex(v: string): boolean {
  return /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
}

/**
 * Finish a canvas-normalized color — '#rrggbb' (opaque) or 'rgba(r, g, b, a)'
 * (with alpha) — into a Monaco-safe hex string. Channels are clamped to 0–255
 * and alpha is folded into an 8-digit hex; unparseable input → `fallback`.
 */
export function normalizedColorToHex(out: string, fallback: string): string {
  const v = (out || '').trim();
  if (v.startsWith('#')) return v;
  const m = /^rgba?\(([^)]+)\)/.exec(v);
  if (!m) return fallback;
  const parts = m[1].split(',').map((s) => s.trim());
  const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  const [r, g, b] = parts.slice(0, 3).map((n) => parseFloat(n));
  if ([r, g, b].some((n) => Number.isNaN(n))) return fallback;
  const a = parts.length > 3 ? Math.round(parseFloat(parts[3]) * 255) : 255;
  return a >= 255 ? `#${ch(r)}${ch(g)}${ch(b)}` : `#${ch(r)}${ch(g)}${ch(b)}${ch(a)}`;
}
