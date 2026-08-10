/**
 * ADR-035 D6 — which WRITER this tab is, on a host whose capture store is scoped
 * to the origin rather than to the tab.
 *
 * The shared `captureLease` module puts liveness in the record every holder
 * reads, and every call it makes needs one thing from the host: a stable name
 * for the writer. This module is that name, and the only decision in it is where
 * it is kept.
 *
 * **`sessionStorage`, not `localStorage` and not a module variable.**
 *
 * - A module variable dies with the page, so a tab that RELOADS mid-recording
 *   comes back as a stranger to its own lease and has to wait
 *   `MEETING_CAPTURE_LEASE_STALE_MS` before it can touch the recording it was
 *   making a second ago. `acquireCaptureLease` deliberately lets the same
 *   `holderId` retake a fresh lease at any time, and a fresh id per load throws
 *   that away.
 * - `localStorage` is shared by every tab of the origin, which is the exact
 *   thing the id has to distinguish. Two tabs with one id is the four-guards
 *   defect wearing a new hat: every "is somebody else writing?" question would
 *   answer "no, that is me".
 *
 * `sessionStorage` is per tab AND survives a reload, which is precisely the pair
 * of properties wanted. A browser that refuses it (private mode, partitioned
 * storage, a blocked origin) falls back to a per-call id: the lease then still
 * protects a live recording from another tab, and the only thing lost is the
 * reload's fast reclaim — the safe half of the trade.
 */
import { newCaptureHolderId } from "@kinqs/brainrouter-core/meetings";

/** Namespaced like every other key this product puts in web storage. */
export const MEETING_CAPTURE_HOLDER_KEY = "brainrouter:meeting-capture-holder";

/** The two methods this needs, so a test does not have to be a browser. */
export interface CaptureHolderStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * This tab's writer id, minted once and remembered.
 *
 * Never throws. Every failure — a storage that refuses to be read, one that
 * refuses to be written, a value some other code overwrote with a number —
 * degrades to a fresh id, because a holder id that cannot be produced would mean
 * no lease at all, and no lease is how a live recording gets deleted.
 */
export function readCaptureHolderId(storage: CaptureHolderStorage | null | undefined): string {
  if (!storage) return newCaptureHolderId();
  try {
    const stored = storage.getItem(MEETING_CAPTURE_HOLDER_KEY);
    if (typeof stored === "string" && stored) return stored;
  } catch {
    // A storage that will not answer cannot be made to; mint below.
    return newCaptureHolderId();
  }
  const minted = newCaptureHolderId();
  try {
    storage.setItem(MEETING_CAPTURE_HOLDER_KEY, minted);
  } catch {
    // Unwritable: this load gets an id nobody remembers, which costs the fast
    // reclaim after a reload and nothing else.
  }
  return minted;
}

/** The browser wrapper — the one line that knows `sessionStorage` exists. */
export function tabCaptureHolderId(): string {
  try {
    return readCaptureHolderId(typeof sessionStorage === "undefined" ? null : sessionStorage);
  } catch {
    // Touching `sessionStorage` at all throws on an origin with storage blocked.
    return readCaptureHolderId(null);
  }
}
