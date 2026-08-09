/**
 * ADR-030 D4 — the walls the structured engine runs inside.
 *
 * The baseline has its own budget (`format/pdf/limits.ts`) and keeps it. These
 * are the extra walls the WebAssembly parser needs, and it needs them for a
 * reason the baseline does not have:
 *
 * > **The engine call is synchronous and cannot be interrupted.** Once
 * > `processPdf` is entered, nothing on that thread runs until it returns —
 * > there is no yield point to check a clock from. Preempting a running
 * > WebAssembly instance requires a second thread to terminate it.
 *
 * That second thread now exists (`structured.ts`), which is what makes the last
 * two walls below real rather than aspirational. The bounds are:
 *
 *  - `maxBytes` bounds what the engine is handed at all, and it is deliberately
 *    far below the baseline's own byte cap. It is NOT a memory bound, and this
 *    comment used to claim it was. Measured: an 812-byte file of nested Flate
 *    streams drives the engine to 933 MB of resident memory, against 84 MB for
 *    the same file with the baseline alone — because what the parser holds in
 *    linear memory is the INFLATED document, which the compressed size bounds no
 *    better here than it does anywhere else (`format/pdf/limits.ts` exists for
 *    that reason on our side of the seam).
 *  - `maxPages` bounds the work inside the one expensive call — the engine takes
 *    an explicit page list, so a 4,000-page document costs what 200 pages cost.
 *  - `canaryFraction` is the cheap measurement of the expensive pass. The
 *    classification pass walks the same object graph as extraction and costs a
 *    predictable fraction of it (41 ms against 96 ms on our own 13-page deck).
 *    If classifying ate more than this share of the remaining budget, extraction
 *    would blow it, so we refuse before entering the longer call. Kept even
 *    though the parse can now be terminated: refusing early is cheaper than
 *    killing a thread, and it costs nothing.
 *  - `timeBudgetMs` is enforced DURING the engine call, by terminating the
 *    worker. Before there was a worker it could only be checked between calls,
 *    which is why a 522 KB decompression bomb ran for as long as it wanted.
 *  - `maxMemoryBytes` is the memory bound D4 asks for, and it is a watchdog
 *    rather than an allocator limit — deliberately, because no allocator limit
 *    exists for the thing that grows. A worker's `resourceLimits` cap its V8
 *    HEAP; WebAssembly linear memory is not on that budget, and the bomb's
 *    1.9 GB is `memory.grow` inside the module. So the parse is watched, and a
 *    parse whose resident growth passes this is stopped and its thread retired.
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
  /**
   * Resident growth one parse may cause before its thread is terminated.
   *
   * Measured against real work rather than guessed: a 4,000-page document costs
   * 182 MB and a 50 MB file costs 202 MB, while the decompression bomb this
   * exists for reached 1,879 MB. The gap is wide enough that the wall sits well
   * clear of honest documents and well below the number that hurts a host.
   */
  maxMemoryBytes: number;
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
  maxMemoryBytes: 512 * 1024 * 1024,
};

export function resolveDocumentBounds(overrides?: Partial<DocumentBounds>): DocumentBounds {
  return { ...DOCUMENT_BOUNDS, ...(overrides ?? {}) };
}
