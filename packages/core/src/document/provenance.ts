/**
 * ADR-027 D4 (P8-3) — page and region provenance.
 *
 * D4: "Where those systems only record character offsets, we will record page
 * and region for PDFs, because a citation the human cannot visually verify does
 * not discharge cognitive debt."
 *
 * That last clause is the whole justification, and it is a claim about people
 * rather than about data. A character offset is verifiable in principle — you
 * could count to it — but nobody does. So a citation carrying only offsets gets
 * trusted without being checked, which is the same outcome as having no
 * citation, dressed up as rigour. A page number and a highlightable rectangle
 * can be checked in two seconds, and a check that takes two seconds actually
 * happens.
 *
 * This maps the character offsets produced by chunking onto the page layout
 * recovered from a PDF. The mapping is the fiddly part and the place a citation
 * silently drifts to the wrong page, so it is separated out and tested on its
 * own.
 */

/** A rectangle in PDF user space. Origin bottom-left, as PDFs define it. */
export interface Region {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One laid-out run of text, as an extractor reports it.
 *
 * `start`/`end` are offsets into the SAME string that was chunked. If an
 * extractor emits text for its own use and different text for chunking, every
 * citation is wrong — so the contract is one string, one offset space.
 */
export interface TextRun {
  start: number;
  end: number;
  region: Region;
}

export interface SpanProvenance {
  /** Pages the span touches, ascending. */
  pages: readonly number[];
  /** One rectangle per page, unioned across runs on that page. */
  regions: readonly Region[];
  /**
   * True when the span extends past the runs we have layout for. The citation
   * still resolves, but its highlight is incomplete — and saying so is the
   * difference between a partial answer and a wrong one.
   */
  partial: boolean;
}

/** Union two rectangles on the same page. */
function union(a: Region, b: Region): Region {
  const left = Math.min(a.x, b.x);
  const bottom = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y + a.height, b.y + b.height);
  return { page: a.page, x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * Resolve a character span to the pages and regions it occupies.
 *
 * A run counts when it OVERLAPS the span, not when it is contained by it.
 * Requiring containment would drop the first and last runs of nearly every
 * citation — the two that show where it starts and ends, which is precisely
 * what a reader looks at.
 */
export function provenanceForSpan(
  runs: readonly TextRun[],
  span: { start: number; end: number },
): SpanProvenance {
  if (span.end <= span.start) return { pages: [], regions: [], partial: false };

  const byPage = new Map<number, Region>();
  let coveredStart = Number.POSITIVE_INFINITY;
  let coveredEnd = Number.NEGATIVE_INFINITY;

  for (const run of runs) {
    // Half-open overlap: a run ending exactly where the span begins does not
    // touch it, and including it would highlight the preceding word.
    if (run.end <= span.start || run.start >= span.end) continue;
    const existing = byPage.get(run.region.page);
    byPage.set(run.region.page, existing ? union(existing, run.region) : run.region);
    coveredStart = Math.min(coveredStart, run.start);
    coveredEnd = Math.max(coveredEnd, run.end);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  return {
    pages,
    regions: pages.map((page) => byPage.get(page)!),
    // Nothing at all, or layout that stops short of the span's extent.
    partial: pages.length === 0 || coveredStart > span.start || coveredEnd < span.end,
  };
}

/**
 * A human-checkable description of where a citation lives.
 *
 * Page numbers are 1-based here even though the model is 0-based internally,
 * because the reader is looking at a page number printed on a document, not at
 * an array index.
 */
export function describeProvenance(provenance: SpanProvenance): string {
  if (provenance.pages.length === 0) return 'Location unknown — this citation cannot be verified.';
  const pages = provenance.pages.map((page) => page + 1);
  const where = pages.length === 1
    ? `page ${pages[0]}`
    : `pages ${pages[0]}–${pages[pages.length - 1]}`;
  return provenance.partial
    ? `${where} (partial — some of this span has no layout information)`
    : where;
}

/**
 * Check that a run set is usable before citations are built on it.
 *
 * Overlapping runs are the failure that matters: two runs claiming the same
 * characters on different pages make a citation resolve to both, and which one
 * a reader is shown becomes an accident of iteration order.
 */
export function runProblems(runs: readonly TextRun[]): readonly string[] {
  const problems: string[] = [];
  const ordered = [...runs].sort((a, b) => a.start - b.start);

  for (const run of ordered) {
    if (run.end <= run.start) problems.push(`Run at ${run.start} has a non-positive length`);
    if (run.region.width < 0 || run.region.height < 0) {
      problems.push(`Run at ${run.start} has a negative-size region`);
    }
    if (run.region.page < 0) problems.push(`Run at ${run.start} has a negative page number`);
  }
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      problems.push(
        `Runs overlap at [${current.start}, ${previous.end}) — a span there resolves to two places`,
      );
    }
  }
  return problems;
}
