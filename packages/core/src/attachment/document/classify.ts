/**
 * ADR-030 D3 — deciding what each page is, and saying it.
 *
 * §6 is explicit about how this work is judged: getting the two-column page and
 * the table right is the parser working, and saying *"the appendix is a scan and
 * I cannot read it"* — rather than answering from nothing — is the whole ADR. So
 * this module has one job and it is the sentence, not the score.
 *
 * Two sources disagree usefully, and the disagreement is the point:
 *
 *  - The structured engine reports which pages need OCR. It is the better judge
 *    of a page, and it is wrong in BOTH directions: it flags a page with very
 *    little text as needing OCR even when that text is real and extractable, and
 *    — measured on a document of three typeset pages and one scanned appendix —
 *    it flags nothing at all, because its verdict is reached for the document
 *    before it is reported per page. One scan among several text pages is
 *    exactly the shape §6 judges this on, and exactly the shape it misses.
 *  - The baseline knows, per page, how many characters it decoded, how many
 *    images were drawn, and how big the biggest one was. It cannot read, but it
 *    cannot be wrong about whether a picture is covering the page.
 *
 * So neither source is the verdict on its own. The baseline overrules the engine
 * in both directions, and each direction removes a silent wrong answer:
 *
 *  - **flagged, but the characters are real** → TEXT. The difference between
 *    reporting a mixed document as entirely unreadable and reading the half of
 *    it that is readable.
 *  - **not flagged, but a picture covers the page and the only text on it is a
 *    stamp** → SCAN. This is how a scanned exhibit actually arrives: a Bates
 *    number, a docket header, a CONFIDENTIAL legend, stamped natively onto a
 *    rasterised page. Without this the page reports as text, the notice vanishes,
 *    and the turn receives the stamp line as though it were the appendix — the
 *    exact state §6 says the whole ADR exists to prevent.
 */
import type { PdfDocumentExtract, PdfLimit, PdfPageExtract } from '../format/pdf/index.js';
import type { StructuredResult } from './structured.js';
import type { DocumentClassification, DocumentPageKind, ParsedDocumentPage } from './types.js';

/**
 * Characters on a page below which the baseline's "there is text here" is not
 * strong enough to overrule the engine.
 *
 * Small on purpose — the baseline is being used as a check on a heuristic, not
 * as a second heuristic. It is NOT the guard against a running header being
 * mistaken for a text layer: a real Bates stamp or docket header runs to 45-90
 * characters and clears any bar low enough to still admit a genuinely sparse
 * page. `coversPage` is what separates those two, because the difference is not
 * how much text there is, it is what is underneath it.
 */
const MIN_CHARS_TO_OVERRULE = 40;

/**
 * The most text a page can carry and still be furniture stamped onto a picture.
 *
 * Measured against the real thing: `Case 1:26-cv-04417-ABC Document 45-2 Filed
 * 03/14/26 Page 8 of 16 PageID #: 1187` is 83 characters, a Bates number with a
 * CONFIDENTIAL legend is around 60, and a running header with a page number in
 * both margins reaches about 160. A typeset page of body text is 3,000 to 6,000
 * — more than an order of magnitude away — so this line does not have to be
 * fine, and it sits above every stamp we have seen rather than between them.
 *
 * It only ever applies to a page a picture covers, which is the guard that makes
 * the number safe: a paragraph on an unillustrated page is text at any count.
 */
const MAX_STAMP_CHARS = 200;

/**
 * Share of a page one image must cover before the page is the image.
 *
 * A scan covers essentially all of it; a wordmark on a title page covers a few
 * per cent. Half is not a tuned midpoint between two close things, it is a gap
 * with nothing in it, chosen high enough that a half-page figure with a caption
 * stays a text page and low enough that a scan inset in a margin still counts.
 */
const MIN_IMAGE_COVERAGE = 0.5;

/** US Letter, for a page that declares no MediaBox and so has no area of its own. */
const DEFAULT_PAGE_AREA = 612 * 792;

/** Ranges listed in a notice before it stops naming them and starts counting. */
const MAX_LISTED_RANGES = 8;

export interface ClassifyInput {
  floor: PdfDocumentExtract;
  structured: StructuredResult | null;
  /** Pages the structured engine was allowed to look at. */
  maxPages: number;
}

export interface Classified {
  pages: ParsedDocumentPage[];
  classification: DocumentClassification;
  classifiedBy: 'structured' | 'baseline';
}

export function classifyDocument(input: ClassifyInput): Classified {
  const { floor, structured } = input;
  const byIndex = new Map(floor.pages.map((page) => [page.index, page]));
  const known = new Set<number>(byIndex.keys());
  if (structured) {
    const reach = Math.min(structured.pageCount, input.maxPages);
    for (let i = 1; i <= reach; i++) known.add(i);
  }

  const needsOcr = new Set(structured?.pagesNeedingOcr ?? []);
  const reasons = new Map<number, string[]>();
  for (const entry of structured?.ocrReasonsByPage ?? []) reasons.set(entry.page, entry.reasons);

  const pages: ParsedDocumentPage[] = [];
  for (const index of [...known].sort((a, b) => a - b)) {
    const page = byIndex.get(index);
    const chars = page?.charCount ?? 0;
    const images = page?.imageCount ?? 0;
    // A page whose glyphs could not be decoded still HAS a text layer, and the
    // baseline has already written `[unreadable page N: …]` onto the line. See
    // `DocumentPageKind` for why that is `text` and not a scan.
    const undecodable = (page?.undecodableRuns ?? 0) > 0;
    const covered = coversPage(page);
    // A picture over the whole page with nothing but furniture written on it.
    const stamped = covered && chars <= MAX_STAMP_CHARS && !undecodable;

    if (!structured) {
      pages.push({ index, kind: baselineKind(chars, images, undecodable, stamped) });
      continue;
    }
    if (undecodable) {
      pages.push({ index, kind: 'text' });
      continue;
    }
    if (needsOcr.has(index)) {
      // Overruled only for characters no picture is sitting behind. The engine
      // flagged this page; "there are 45 characters on it" is not an argument
      // against that when 45 characters is what a stamp weighs.
      const kind = chars >= MIN_CHARS_TO_OVERRULE && !covered
        ? 'text'
        : ocrKind(reasons.get(index) ?? [], images);
      pages.push({ index, kind });
      continue;
    }
    // Not flagged. The engine reaches its verdict for the document, so a lone
    // scanned appendix behind three typeset pages arrives here unmarked, and the
    // baseline's two numbers are then the only thing that knows.
    pages.push({ index, kind: stamped ? ocrKind(reasons.get(index) ?? [], images) : 'text' });
  }

  return {
    pages,
    classification: summarise(pages, floor),
    classifiedBy: structured ? 'structured' : 'baseline',
  };
}

/**
 * The baseline alone — D1's floor, with no engine to check against.
 *
 * It cannot tell a photograph from a scan, so a page whose text an image has
 * covered is reported as `scanned` rather than `image`: both mean "no text
 * layer", and `scanned` is the one that changes what the reader does next.
 *
 * The stamp test is applied here too, and not as a courtesy. When the parser is
 * missing this is the ONLY judge there is, and a scanned exhibit is no less a
 * scan for having been read by the weaker of the two engines.
 */
function baselineKind(
  chars: number,
  images: number,
  undecodable: boolean,
  stamped: boolean,
): DocumentPageKind {
  if (stamped) return 'scanned';
  if (chars > 0 || undecodable) return 'text';
  return images > 0 ? 'scanned' : 'empty';
}

/**
 * Is a single image big enough to BE this page?
 *
 * The comparison is drawn area against page area, both in user-space units, so
 * it is independent of the image's pixel dimensions — a 200 dpi scan and a 600
 * dpi one of the same sheet cover the page identically, and a 4,000-pixel logo
 * printed an inch wide covers almost none of it.
 */
function coversPage(page: PdfPageExtract | undefined): boolean {
  if (!page || page.imageCount === 0 || !(page.maxImageArea > 0)) return false;
  const declared = (page.width ?? 0) * (page.height ?? 0);
  const area = declared > 0 ? declared : DEFAULT_PAGE_AREA;
  return page.maxImageArea >= area * MIN_IMAGE_COVERAGE;
}

/**
 * The engine's own reason for wanting OCR, in our vocabulary.
 *
 * `scanned` is a page-sized raster. `vector_text` is lettering drawn as artwork —
 * there is nothing to extract at any effort, which is `image`, not a scan
 * waiting for OCR. Anything else falls back to what the baseline saw.
 */
function ocrKind(reasons: readonly string[], images: number): DocumentPageKind {
  for (const reason of reasons) {
    if (reason === 'scanned') return 'scanned';
    if (reason === 'vector_text') return 'image';
  }
  return images > 0 ? 'scanned' : 'empty';
}

function summarise(pages: readonly ParsedDocumentPage[], floor: PdfDocumentExtract): DocumentClassification {
  if (floor.encrypted) return 'unreadable';
  if (pages.length === 0) return 'unreadable';
  const text = pages.filter((page) => page.kind === 'text').length;
  const scanned = pages.filter((page) => page.kind === 'scanned').length;
  const image = pages.filter((page) => page.kind === 'image').length;
  if (scanned + image === 0) return 'text';
  if (text > 0) return 'mixed';
  return scanned > 0 ? 'scanned' : 'image';
}

export interface NoticeInput {
  classification: DocumentClassification;
  pages: readonly ParsedDocumentPage[];
  pageCount?: number;
  encrypted: boolean;
  /**
   * The walls that shaped THE TEXT WE ARE RETURNING — not every wall the run
   * hit.
   *
   * The distinction earns its keep: when the structured engine is refused on
   * time and the baseline answers instead, the returned text is complete and
   * merely unstructured. "The parse ran out of time, so the text may be
   * incomplete" would be false, and `structureNote` already says the true thing.
   */
  limits: readonly PdfLimit[];
  /** True when the text came from printable runs harvested out of the file. */
  scavenged: boolean;
  /** True when there is document text to talk about. */
  hasText: boolean;
  /**
   * Why the structured engine did not answer, when it did not.
   *
   * Needed here and not only in `diagnostics` because of one case that reads as
   * a lie: the engine is stopped by a resource wall, the baseline recovers
   * nothing, and `limits` — correctly narrowed to the walls that shaped the
   * text we RETURN — carries none of it. The notice then says the document has
   * "no content", which asserts a fact about the document from a failure of
   * ours. A 512 KB decompression bomb produced exactly that.
   *
   * ADR-028 B1: do not claim a state you have not established. We did not
   * establish that the document is empty; we established that we stopped.
   */
  structureUnavailable?: string;
}

/**
 * The sentences we are prepared to say in our own voice.
 *
 * Assembled entirely from page numbers, counts and fixed strings. Nothing from
 * the document reaches here — see `types.ts` for why that invariant is the
 * reason this string may be presented outside the untrusted-content fence.
 *
 * Returns '' when there is nothing worth saying. A notice on every attachment is
 * a notice the model stops reading, and it needs to be believed on the day a
 * scanned appendix arrives.
 */
export function renderNotice(input: NoticeInput): string {
  const parts: string[] = [];
  const total = input.pageCount ?? input.pages.length;

  if (input.encrypted) {
    parts.push('This document is encrypted, so none of its contents could be read.');
  } else if (input.classification === 'unreadable') {
    // Two different facts, and saying the first when the second is true is the
    // kind of small lie this ADR is about: a file we could not parse but DID
    // harvest bytes from has text, and the sentence below explains where from.
    parts.push(input.hasText
      ? 'This document\'s structure could not be parsed.'
      : 'This document\'s structure could not be parsed, so no text was extracted.');
  } else if (input.classification === 'scanned' || input.classification === 'image') {
    // "which is not configured" is true because there is no OCR anywhere in this
    // repository (ADR-030 §2). D3 routes to one when there is one, and that
    // routing happens BEFORE this sentence is rendered — so if OCR ever lands
    // and this branch is still reached, the claim needs a condition, not a
    // rewrite.
    const what = input.classification === 'scanned'
      ? `This document is a scan: ${countPages(total)} of images with no text layer`
      : `This document has no text layer: its ${countPages(total)} are images or vector artwork`;
    // "so there is no text to extract" is the true sentence for a bare scan and
    // a FALSE one the moment a stamp is printed over the picture — and that is
    // the normal form, which is why the classifier goes to the trouble of still
    // calling such a page a scan. Saying it anyway and then printing the stamp
    // underneath is the same small lie in the other direction: it invites the
    // reader to treat the one line we do have as the document.
    parts.push(input.hasText
      ? `${what}. The only text below is printed over ${total === 1 ? 'it' : 'them'} — a header, a `
        + 'stamp or a page number — and is not the document\'s contents, which were not read. '
        + 'Reading them needs OCR, which is not configured.'
      : `${what}, so there is no text to extract. Reading it needs OCR, which is not configured.`);
  } else if (input.classification === 'mixed') {
    const flagged = input.pages.filter((page) => page.kind === 'scanned' || page.kind === 'image');
    const one = flagged.length === 1;
    parts.push(
      `${one ? 'Page' : 'Pages'} ${formatRanges(flagged.map((page) => page.index))} of this `
      + `${total}-page document ${one ? 'is a scan' : 'are scans'} with no text layer; `
      + `${one ? 'its' : 'their'} contents are NOT in the text below and were not read.`,
    );
  } else if (!input.hasText) {
    // "No content" is a claim about the DOCUMENT. Only make it when nothing of
    // ours got in the way — otherwise report our own failure, which is the
    // thing we actually established.
    parts.push(input.structureUnavailable
      ? `This document could not be read: ${input.structureUnavailable}. Whether it has content is unknown.`
      : `This document has ${countPages(total)} and no content: no text and no images.`);
  }

  if (input.scavenged) {
    parts.push(
      'The text below was harvested from the file\'s raw bytes rather than parsed from its pages, '
      + 'so it may be incomplete or may not be the document\'s contents at all.',
    );
  }
  for (const limit of limitSentences(input.limits, total)) parts.push(limit);

  return parts.join(' ');
}

/**
 * D2's required line: the parser was not there, so the answer is worse.
 *
 * Only said when there is text for it to be about. On a scanned document the
 * structured parser being unavailable changes nothing — there was no structure
 * to lose — and the sentence would only dilute the one that matters.
 */
export function renderStructureNote(reason: string | undefined, hasText: boolean): string {
  if (!reason || !hasText) return '';
  return `Document structure was unavailable — ${reason} — so the text is unstructured: `
    + 'headings, reading order for columns, and tables are not reconstructed.';
}

function limitSentences(limits: readonly PdfLimit[], total: number): string[] {
  const out: string[] = [];
  if (limits.includes('bytes')) out.push('The file is larger than this parser accepts and was not read.');
  if (limits.includes('pages')) out.push(`Only some of the ${countPages(total)} were read: the page limit was reached.`);
  if (limits.includes('time')) out.push('The parse ran out of its time budget and stopped early, so the text may be incomplete.');
  if (limits.includes('inflated')) out.push('The document expands to more data than this parser accepts, so it was read only in part.');
  if (limits.includes('memory')) out.push('The document needed more memory than this parser is allowed, so reading it was stopped.');
  return out;
}

function countPages(n: number): string {
  return n === 1 ? '1 page' : `${n} pages`;
}

/**
 * `[4, 5, 6, 9]` → `4-6, 9`.
 *
 * A single pass over a sorted copy, bounded by `MAX_LISTED_RANGES` so a document
 * that alternates scanned and text pages a thousand times cannot turn the notice
 * into the whole context window.
 */
export function formatRanges(numbers: readonly number[]): string {
  const sorted = [...numbers].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  const parts: string[] = [];
  let omitted = 0;
  let start = -1;
  let prev = -1;
  const flush = (): void => {
    if (start < 0) return;
    if (parts.length >= MAX_LISTED_RANGES) omitted += prev - start + 1;
    else parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = -1;
  };
  for (const n of sorted) {
    if (start < 0) {
      start = n;
      prev = n;
      continue;
    }
    if (n === prev) continue;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    flush();
    start = n;
    prev = n;
  }
  flush();
  if (omitted > 0) parts.push(`and ${omitted} more`);
  return parts.join(', ');
}
