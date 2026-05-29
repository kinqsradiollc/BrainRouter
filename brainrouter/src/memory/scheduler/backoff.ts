/**
 * BRAIN-P1 (0.4.1) — retry backoff policy (BRAIN-DESIGN-T2 §Backoff).
 *
 * `2^attempts × 30s + jitter`, capped at 5 minutes. The schedule lives
 * here in code; the `run_after` column on `memory_jobs` is the
 * authoritative "do not run before" signal the store stamps from this.
 *
 * Pure module (no I/O, no sqlite) so it is unit-testable under vitest.
 */

export const BASE_DELAY_MS = 30_000; // 30s
export const MAX_DELAY_MS = 5 * 60_000; // 5 min
export const JITTER_RATIO = 0.2; // ±20%

/**
 * Backoff delay before the `attempts`-th retry. `attempts` is the
 * (already-incremented) attempt count after the failure that just
 * occurred — i.e. 1 after the first failure.
 *
 * `random` is injectable so tests stay deterministic; defaults to
 * `Math.random`. Result is always in `[0, MAX_DELAY_MS]`.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  // 2^(n-1) so the first retry waits BASE_DELAY, the second 2×, etc.
  const exponential = BASE_DELAY_MS * 2 ** (safeAttempts - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  // Symmetric jitter in ±JITTER_RATIO, then clamp back into range.
  const jitter = capped * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(0, Math.min(MAX_DELAY_MS, Math.round(capped + jitter)));
}
