/**
 * ADR-041 A41-11 — the agent loop's default driver, as a replaceable composition row.
 *
 * A backend runs a turn by delegating to an injected {@link RuntimeTurnExecutor} — the
 * "loop driver": HOW a turn is driven, distinct from the backend's WHERE. ADR-041 §0
 * asks that even this default driver be a *registration*, so a host can swap it (e.g. a
 * bounded-loop instrumenting driver, or a dry-run recorder) without editing
 * `resolveRuntime`.
 *
 * This models it as a single id-keyed row whose value is a {@link LoopDriverWrap}:
 * given the base executor, it returns the executor actually used. The DEFAULT row is
 * the identity wrap, and `resolveRuntime` applies the active row to the executor it
 * hands the backend — so with the default installed the composed call is byte-for-byte
 * the un-wrapped one. Replacing the row is `registerLoopDriver(...)`; the active row's
 * id shows up in `dump-composition` next to the other registries.
 */
import type { RuntimeTurnExecutor } from './runtimeTypes.js';

/** Wraps (or replaces) the base turn executor. The default is identity. */
export type LoopDriverWrap = (base: RuntimeTurnExecutor) => RuntimeTurnExecutor;

/** The id of the built-in default loop-driver row. */
export const DEFAULT_LOOP_DRIVER_ID = 'default';

interface LoopDriverRow {
  id: string;
  wrap: LoopDriverWrap;
}

// The active driver row. Registered (not merely initialized) at module load so
// `registerLoopDriver` has a real, non-test first caller — the default registration
// at the bottom of this file.
let active: LoopDriverRow | null = null;

/**
 * Register the active loop driver, replacing any prior row. `id` names the row for the
 * composition dump; `wrap` receives the backend's base executor and returns the one to
 * actually run (return `base` unchanged for a pure observer).
 */
export function registerLoopDriver(id: string, wrap: LoopDriverWrap): void {
  active = { id, wrap };
}

/** Reset to the built-in identity driver by re-registering the default row. */
export function resetLoopDriver(): void {
  registerLoopDriver(DEFAULT_LOOP_DRIVER_ID, (base) => base);
}

/** The active driver row's id — what `dump-composition` surfaces. */
export function activeLoopDriverId(): string {
  return active?.id ?? DEFAULT_LOOP_DRIVER_ID;
}

/** Apply the active loop driver to `base`. Identity by default → byte-neutral. */
export function applyLoopDriver(base: RuntimeTurnExecutor): RuntimeTurnExecutor {
  return (active ?? { id: DEFAULT_LOOP_DRIVER_ID, wrap: (b: RuntimeTurnExecutor) => b }).wrap(base);
}

// Install the default row at module load — the genuine first consumer of
// `registerLoopDriver`, and what keeps the seam byte-neutral until a host swaps it.
resetLoopDriver();
