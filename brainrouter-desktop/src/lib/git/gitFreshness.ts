/**
 * Git freshness — branch/workspace state is LIVE environment state, never
 * durable session truth, so the desktop re-reads it from the real repo on the
 * triggers that can outdate it (window focus / tab visible — e.g. the user ran
 * `git checkout` in another terminal while the app was in the background).
 *
 * This module is the pure, testable decision: should a focus/visibility event
 * actually fire a refresh, or is it within the debounce window of the last one?
 * Rapid focus/blur/focus bursts (and the focus that fires alongside a
 * visibilitychange) must collapse to a single refresh.
 */

/** Minimum gap between focus-triggered git refreshes (ms). */
export const GIT_FOCUS_MIN_GAP_MS = 1500;
/** Polling fallback for branch changes made while the desktop stays visible. */
export const GIT_VISIBLE_POLL_MS = 5000;

/**
 * True when a focus/visibility-triggered git refresh is due: the tab must be
 * visible and at least `minGapMs` must have elapsed since the last refresh.
 * `lastTs <= 0` means "never refreshed" → always due (when visible).
 */
export function gitRefreshDue(lastTs: number, now: number, visible: boolean, minGapMs: number = GIT_FOCUS_MIN_GAP_MS): boolean {
  if (!visible) return false;
  if (lastTs <= 0) return true;
  return now - lastTs >= minGapMs;
}

export function gitPollRefreshDue(lastTs: number, now: number, visible: boolean, intervalMs: number = GIT_VISIBLE_POLL_MS): boolean {
  if (!visible) return false;
  if (lastTs <= 0) return true;
  return now - lastTs >= intervalMs;
}
