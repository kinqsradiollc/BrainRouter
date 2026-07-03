/**
 * INPUT-ERGO (0.4.5) — shell-style composer history navigation, pure so the
 * ChatApp wiring stays a thin adapter and the cursor/edge logic is unit-tested.
 *
 * Model: `entries` is oldest→newest submitted inputs. A browse position is an
 * index into `entries`, or `LIVE` (-1) meaning "not browsing — showing the
 * user's live draft". ↑ walks toward older, ↓ toward newer and falls off the
 * end back to LIVE (restoring the draft the user was typing).
 */

export const LIVE = -1;

/** Append a submitted input: trim, skip empties, dedupe consecutive, cap size. */
export function appendHistory(entries: string[], submitted: string, cap = 200): string[] {
  const v = (submitted ?? "").trim();
  if (!v) return entries;
  if (entries.length > 0 && entries[entries.length - 1] === v) return entries;
  const next = [...entries, v];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface HistoryMove {
  /** New browse index (LIVE when back at the live draft). */
  index: number;
  /** Value to put in the composer, or null to leave it unchanged (no-op). */
  value: string | null;
}

/**
 * ↑ — step toward older entries. From LIVE, jump to the newest entry. At the
 * oldest entry, stay put (no wrap — matches bash/zsh). Returns value:null when
 * there's nothing to do (empty history).
 */
export function historyPrev(entries: string[], index: number): HistoryMove {
  if (entries.length === 0) return { index, value: null };
  if (index === LIVE) {
    const i = entries.length - 1;
    return { index: i, value: entries[i] };
  }
  if (index <= 0) return { index: 0, value: entries[0] }; // already oldest — stay
  const i = index - 1;
  return { index: i, value: entries[i] };
}

/**
 * ↓ — step toward newer entries. From the newest entry (or beyond), return to
 * LIVE and restore `draft`. From LIVE, no-op.
 */
export function historyNext(entries: string[], index: number, draft: string): HistoryMove {
  if (index === LIVE) return { index: LIVE, value: null };
  if (index >= entries.length - 1) return { index: LIVE, value: draft }; // fell off the new end → live draft
  const i = index + 1;
  return { index: i, value: entries[i] };
}

/**
 * CC-P1.7 — reverse incremental history search (Ctrl+R). Find prompts
 * CONTAINING `query` (case-insensitive), newest-first; `skip` returns the
 * Nth older match so repeated Ctrl+R cycles back through history. Pure.
 */
export function searchHistory(entries: string[], query: string, skip = 0): { value: string; index: number } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let remaining = Math.max(0, skip);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].toLowerCase().includes(q)) {
      if (remaining === 0) return { value: entries[i], index: i };
      remaining -= 1;
    }
  }
  return null;
}
