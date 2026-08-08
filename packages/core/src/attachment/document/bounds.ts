/**
 * ADR-030 D4 — the walls the structured engine runs inside.
 *
 * The baseline has its own budget (`format/pdf/limits.ts`) and keeps it. These
 * are the extra walls the WebAssembly parser needs, and it needs them for a
 * reason the baseline does not have:
 *
 * > **The engine call is synchronous and cannot be interrupted.** Once
 * > `processPdf` is entered, nothing in this process runs until it returns —
 * > there is no yield point to check a clock from. Preempting a running
 * > WebAssembly instance requires a second thread to terminate it, and putting
 * > one behind this seam is a change of shape (a worker script resolved out of a
 * > packaged app archive), not a tweak.
 *
 * So the deadline is enforced at every boundary BETWEEN calls, and the work
 * inside a call is bounded by construction instead:
 *
 *  - `maxBytes` bounds what the engine is handed at all, and it is deliberately
 *    far below the baseline's own byte cap.
 *
 *    It is NOT a memory bound, and this comment used to say it was. Measured:
 *    an 812-byte file of nested Flate streams drives the engine to 933 MB of
 *    resident memory, against 84 MB for the same file with the baseline alone —
 *    because what the parser holds in linear memory is the INFLATED document,
 *    which the compressed size bounds no better here than it does anywhere else
 *    (`format/pdf/limits.ts` exists for that reason on our side of the seam).
 *    The engine returned a reason and did not crash in every hostile case we
 *    have run, so this is a cost rather than a hole; bounding it properly means
 *    a worker thread with a memory cap, which is the change of shape above.
 *    ADR-030 §1.1 is about a comment that claimed a guarantee nobody checked —
 *    stating the measured behaviour is the least this file can do about that.
 *  - `maxPages` bounds the work inside the one expensive call — the engine takes
 *    an explicit page list, so a 4,000-page document costs what 200 pages cost.
 *  - `canaryFraction` is the part that does real work. The cheap classification
 *    pass walks the same object graph as the expensive extraction pass and costs
 *    a predictable fraction of it (41 ms against 96 ms on our own 13-page deck).
 *    So the cheap pass is a measurement of the expensive one: if classifying ate
 *    more than this share of the remaining budget, extraction would blow it, and
 *    we refuse BEFORE entering the call we could not leave.
 */

export interface DocumentBounds {
  /** Largest file the structured engine is handed. */
  maxBytes: number;
  /** Pages the structured engine extracts; beyond this it is given a page list. */
  maxPages: number;
  /** Wall-clock budget for the whole seam, baseline included. */
  timeBudgetMs: number;
  /**
   * Share of the remaining budget the cheap classification pass may spend before
   * the expensive extraction pass is refused. Extraction costs roughly 2.3x
   * classification, so a third is the point past which the sum cannot fit.
   */
  canaryFraction: number;
}

/**
 * Sized against real documents rather than the theoretical maximum: a 433 KB,
 * 13-page deck classifies in ~40 ms and extracts in ~100 ms, so the time budget
 * leaves two orders of magnitude of headroom before it bites, and the byte cap
 * is roughly forty times the largest document anyone has attached.
 */
export const DOCUMENT_BOUNDS: DocumentBounds = {
  maxBytes: 16 * 1024 * 1024,
  maxPages: 200,
  timeBudgetMs: 10_000,
  canaryFraction: 0.35,
};

export function resolveDocumentBounds(overrides?: Partial<DocumentBounds>): DocumentBounds {
  return { ...DOCUMENT_BOUNDS, ...(overrides ?? {}) };
}
