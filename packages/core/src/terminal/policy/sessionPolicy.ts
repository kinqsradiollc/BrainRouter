import type { TerminalGeometry } from '@kinqs/brainrouter-agent-protocol';

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const MIN_TERMINAL_COLS = 2;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_GEOMETRY = 1_000;

function clampDimension(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  const finite = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : fallback;
  return Math.max(minimum, Math.min(MAX_TERMINAL_GEOMETRY, finite));
}

/** Normalize renderer-provided terminal geometry without consulting a host. */
export function normalizeTerminalGeometry(
  cols: number | undefined,
  rows: number | undefined,
): TerminalGeometry {
  return {
    cols: clampDimension(cols, DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS),
    rows: clampDimension(rows, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS),
  };
}

/** Normalize a host-local reattachment key; blank keys disable reattachment. */
export function normalizeTerminalReuseKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

/** Normalize a renderer cursor before a bounded host read. */
export function normalizeTerminalCursor(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
