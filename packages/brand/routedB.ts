/**
 * Canonical BrainRouter "Routed B" geometry.
 *
 * Keep this module React-free so every product surface and Brand Studio export
 * consumes the exact same two filled paths. The mark is intentionally valid at
 * 16px in one color; `accent` may add one flat violet route when space permits.
 */

export const ROUTED_B_VIEWBOX = '0 0 24 24';
export const ROUTED_B_MIN_SIZE = 16;
export const ROUTED_B_ACCENT = '#7C4DFF';

export const ROUTED_B_PATHS = Object.freeze({
  upper: 'M2 2H10L14 6H16C19.314 6 22 8.686 22 12H18C18 10.895 17.105 10 16 10H12.343L8.343 6H2Z',
  lower: 'M2 22H10L14 18H16C19.314 18 22 15.314 22 12H18C18 13.105 17.105 14 16 14H12.343L8.343 18H2Z',
});

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function number(value: number): string {
  return String(Number(finite(value, 0).toFixed(6)));
}

function attribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Pure markup adapter for Brand Studio and non-React renderers. */
export function routedBMarkup(options: {
  x: number;
  y: number;
  size: number;
  color: string;
  /** Omit for a one-color mark. */
  accent?: string;
}): string {
  const x = number(options.x);
  const y = number(options.y);
  const scale = number(Math.max(0, finite(options.size, 0)) / 24);
  const color = attribute(options.color);
  const lowerColor = attribute(options.accent ?? options.color);
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="${ROUTED_B_PATHS.upper}" fill="${color}"/><path d="${ROUTED_B_PATHS.lower}" fill="${lowerColor}"/></g>`;
}
