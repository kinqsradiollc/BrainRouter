/**
 * ADR-030 D1 — the walls a hostile PDF runs inside.
 *
 * A PDF arrives by upload, by connector sync, and by a URL the agent fetched,
 * so every loop in this folder is bounded by the budget created here rather
 * than by the shape of the file. The four that matter:
 *
 *  - **time** — a malformed cross-reference or a cyclic object graph turns a
 *    parse into a wedge; the deadline ends it wherever it is.
 *  - **inflated bytes** — the compressed size bounds nothing. A 40 KB stream
 *    can inflate to gigabytes, so the cap is on the OUTPUT, per stream and for
 *    the document, and it is enforced by `zlib`'s own `maxOutputLength` rather
 *    than by measuring afterwards (measuring afterwards means the allocation
 *    already happened).
 *  - **objects** and **pages** — bound the breadth of the walk.
 *
 * Hitting a wall is never an error: the limit is recorded on the budget and the
 * caller reports a partial answer with the reason. That is the contract the
 * whole module keeps — always answer, and say what you could not do.
 */

/** A bound that stopped the parse, reported alongside whatever text survived. */
export type PdfLimit =
  | 'bytes'
  | 'time'
  | 'pages'
  | 'objects'
  | 'inflated'
  | 'depth'
  /**
   * ADR-030 D4 — the parse was stopped because it was growing without bound.
   *
   * Distinct from `bytes`, which is about the file we were handed: a 522 KB
   * document can inflate to gigabytes, and telling someone their small file was
   * "too large" would send them looking for the wrong thing.
   */
  | 'memory'
  | 'encrypted'
  /**
   * The last-resort printable-run harvest read only part of the file.
   *
   * Diagnostic only — it deliberately has no sentence of its own in the notice,
   * because a harvest already carries one saying the text "may be incomplete or
   * may not be the document's contents at all", and that is the same fact said
   * better. It is here so the wall is recorded rather than silently absorbed.
   */
  | 'scavenge'
  | 'malformed';

export interface PdfBounds {
  /** Largest input we will look at at all. */
  maxBytes: number;
  /**
   * Bytes the last-resort printable-run harvest will search.
   *
   * Far below `maxBytes` on purpose. That cap is what a structured parse may
   * consume; this one is what a linear scan for readable runs may consume, and
   * the two are not the same budget — the harvest exists to salvage a few
   * thousand characters from a file whose structure told us nothing, so reading
   * tens of megabytes of it buys nothing and costs a copy of all of them.
   */
  maxScavengeBytes: number;
  /** Largest output a single stream may inflate to. */
  maxInflatedBytesPerStream: number;
  /** Largest total inflation across the whole document. */
  maxInflatedBytesTotal: number;
  /** Pages whose content we walk (the reported page count is not capped). */
  maxPages: number;
  /** Indirect objects we will parse. */
  maxObjects: number;
  /** Wall-clock budget for the whole extraction. */
  timeBudgetMs: number;
  /** Nesting depth for arrays/dicts, form XObjects and page-tree recursion. */
  maxDepth: number;
}

/**
 * Defaults sized against real documents, not against the theoretical maximum:
 * a 13-page 433 KB deck inflates to ~1.5 MB and parses in well under a second,
 * so these leave two orders of magnitude of headroom before they bite.
 */
export const PDF_BOUNDS: PdfBounds = {
  maxBytes: 64 * 1024 * 1024,
  maxScavengeBytes: 8 * 1024 * 1024,
  maxInflatedBytesPerStream: 16 * 1024 * 1024,
  maxInflatedBytesTotal: 64 * 1024 * 1024,
  maxPages: 500,
  maxObjects: 100_000,
  timeBudgetMs: 5_000,
  maxDepth: 24,
};

export interface PdfBudget {
  bounds: PdfBounds;
  /** Absolute `Date.now()` after which the parse stops where it stands. */
  deadline: number;
  inflatedBytes: number;
  objectsParsed: number;
  hit: PdfLimit[];
}

export function createBudget(overrides?: Partial<PdfBounds>): PdfBudget {
  const bounds: PdfBounds = { ...PDF_BOUNDS, ...(overrides ?? {}) };
  return { bounds, deadline: Date.now() + bounds.timeBudgetMs, inflatedBytes: 0, objectsParsed: 0, hit: [] };
}

/** Record a wall we hit. Deduplicated — the report says *which*, not how often. */
export function noteLimit(budget: PdfBudget, limit: PdfLimit): void {
  if (!budget.hit.includes(limit)) budget.hit.push(limit);
}

/** True once the deadline has passed; records `time` the first time it does. */
export function outOfTime(budget: PdfBudget): boolean {
  if (Date.now() < budget.deadline) return false;
  noteLimit(budget, 'time');
  return true;
}

/**
 * Reserve `bytes` of inflation. Returns the per-stream allowance still
 * available, or 0 when the document has already spent its total — callers pass
 * the allowance to `zlib` so the memory is never allocated in the first place.
 */
export function inflateAllowance(budget: PdfBudget): number {
  const left = budget.bounds.maxInflatedBytesTotal - budget.inflatedBytes;
  if (left <= 0) {
    noteLimit(budget, 'inflated');
    return 0;
  }
  return Math.min(left, budget.bounds.maxInflatedBytesPerStream);
}

/** Charge produced bytes against the document total. */
export function spendInflate(budget: PdfBudget, bytes: number): void {
  budget.inflatedBytes += bytes;
}

/** Charge one parsed object; false once the object budget is spent. */
export function spendObject(budget: PdfBudget): boolean {
  budget.objectsParsed += 1;
  if (budget.objectsParsed > budget.bounds.maxObjects) {
    noteLimit(budget, 'objects');
    return false;
  }
  return true;
}
