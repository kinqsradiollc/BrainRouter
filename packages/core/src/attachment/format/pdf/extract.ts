/**
 * ADR-030 D1 — the entry point: bytes in, pages of positioned text out, and
 * the flat capped string the attachment pipeline has always taken.
 *
 * Three passes, each a fallback for the one before, and each one honest about
 * which it used:
 *
 *  1. **The page tree.** Content streams inflated, operators walked, text
 *     decoded through the fonts the document declares. This is the answer.
 *  2. **Loose content streams.** When the page tree is broken or absent, any
 *     stream that looks like page content (`BT` … `Tj`) is walked anyway. Still
 *     real text operators, just recovered from a damaged file.
 *  3. **Printable runs.** The pre-ADR behaviour, kept because a file can be
 *     structurally hopeless and still readable — but now gated on the result
 *     LOOKING like prose, and flagged `scavenged` so nobody upstream mistakes
 *     it for a parse. Filling the context cap with `bl0$ s eI6 U"k'` is the
 *     failure this ADR was written about.
 *
 * The contract the module has always had is unchanged and load-bearing: it
 * never throws, and an input it cannot read yields empty text rather than an
 * exception on someone's upload path.
 */
import { walkPage } from './content.js';
import { flattenDocument } from './flatten.js';
import { getObject, listPages, loadDocument, streamBytes, type PdfDoc } from './document.js';
import { createBudget, noteLimit, outOfTime, type PdfBounds, type PdfBudget } from './limits.js';
import type { PdfFont } from './fonts.js';
import type { PdfDocumentExtract, PdfExtract, PdfLimit, PdfPageExtract } from './types.js';

const DEFAULT_MAX_CHARS = 20000;

export interface PdfExtractOptions {
  /** Cap on the returned text. Negative disables the cap. */
  maxChars?: number;
  /** Override any of the safety bounds — the defaults are the shipping ones. */
  bounds?: Partial<PdfBounds>;
}

/**
 * Parse a PDF into pages of positioned text runs.
 *
 * Never throws. Whatever stopped it — a bound, a malformed object graph, an
 * encrypted file — comes back in `limits` next to whatever was extracted before
 * it stopped.
 */
export function extractPdfDocument(buf: Buffer, opts?: PdfExtractOptions): PdfDocumentExtract {
  const budget = createBudget(opts?.bounds);
  // Built per call rather than shared: a caller that appends to `pages` on an
  // empty result must not be editing the next caller's answer.
  const empty = (): PdfDocumentExtract => (
    { pages: [], limits: [...budget.hit], undecodableRuns: 0, encrypted: false }
  );
  if (!buf || buf.length === 0) return empty();
  if (buf.length > budget.bounds.maxBytes) {
    noteLimit(budget, 'bytes');
    return empty();
  }

  try {
    const doc = loadDocument(buf, budget);
    const pages = extractPages(doc, budget);
    const declared = declaredPageCount(doc.src);
    const walked = pages.length;
    const result: PdfDocumentExtract = {
      pages,
      limits: [...budget.hit],
      undecodableRuns: pages.reduce((sum, page) => sum + page.undecodableRuns, 0),
      encrypted: doc.encrypted,
    };
    const pageCount = budget.hit.includes('pages') || walked === 0 ? (declared ?? walked) : walked;
    if (pageCount > 0) result.pageCount = pageCount;
    return result;
  } catch {
    // The module's contract is that it always answers. A parser bug must degrade
    // an attachment, never fail the upload that carried it.
    noteLimit(budget, 'malformed');
    return empty();
  }
}

function extractPages(doc: PdfDoc, budget: PdfBudget): PdfPageExtract[] {
  if (doc.encrypted) {
    noteLimit(budget, 'encrypted');
    return [];
  }
  const nodes = listPages(doc);
  const fontCache = new Map<string, PdfFont>();
  const pages: PdfPageExtract[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (outOfTime(budget)) break;
    if (pages.length >= budget.bounds.maxPages) {
      noteLimit(budget, 'pages');
      break;
    }
    const node = nodes[i];
    let walk;
    try {
      walk = walkPage(doc, node, fontCache);
    } catch {
      // One unreadable page is one unreadable page, not a failed document.
      noteLimit(budget, 'malformed');
      continue;
    }
    const page: PdfPageExtract = {
      index: i + 1,
      items: walk.items,
      charCount: walk.items.reduce((sum, item) => sum + item.text.length, 0),
      undecodableRuns: walk.undecodableRuns,
      droppedGlyphs: walk.droppedGlyphs,
      imageCount: walk.imageCount,
      maxImageArea: walk.maxImageArea,
    };
    if (node.mediaBox) {
      page.width = Math.abs(node.mediaBox[2] - node.mediaBox[0]);
      page.height = Math.abs(node.mediaBox[3] - node.mediaBox[1]);
    }
    if (node.rotate) page.rotation = ((Math.round(node.rotate / 90) * 90) % 360 + 360) % 360;
    pages.push(page);
  }

  const anyText = pages.some((page) => page.charCount > 0 || page.undecodableRuns > 0);
  if (!anyText) {
    const loose = walkLooseStreams(doc, budget, fontCache) ?? walkWholeSource(doc, budget, fontCache);
    if (loose) {
      if (pages.length === 0) return [loose];
      // Recovered runs cannot be attributed to a page, so they land on the first
      // one rather than inventing a page the document does not have.
      pages[0] = {
        ...pages[0],
        items: loose.items,
        charCount: loose.charCount,
        undecodableRuns: loose.undecodableRuns,
        droppedGlyphs: loose.droppedGlyphs,
        imageCount: pages[0].imageCount + loose.imageCount,
        maxImageArea: Math.max(pages[0].maxImageArea, loose.maxImageArea),
      };
    }
  }
  return pages;
}

/**
 * Pass 2 — content streams the page tree does not reach.
 *
 * A stream qualifies only if it reads like page content (`BT` with a show
 * operator). That gate matters: an embedded font program or an image blob will
 * occasionally contain `(x) Tj`-shaped bytes by chance, and walking those is
 * how a "recovery" pass reinvents the scavenging this ADR is deleting.
 */
function walkLooseStreams(
  doc: PdfDoc,
  budget: PdfBudget,
  fontCache: Map<string, PdfFont>,
): PdfPageExtract | null {
  const merged: PdfPageExtract = {
    index: 1,
    items: [],
    charCount: 0,
    undecodableRuns: 0,
    droppedGlyphs: 0,
    imageCount: 0,
    maxImageArea: 0,
  };
  let walked = 0;
  for (const num of [...doc.offsets.keys()].sort((a, b) => a - b)) {
    if (outOfTime(budget) || walked >= 64) break;
    const obj = getObject(doc, num);
    if (!obj || obj.t !== 'stream') continue;
    if (obj.v.has('Subtype') || obj.v.has('Length1') || obj.v.has('Type')) continue;
    const bytes = streamBytes(doc, obj);
    if (!bytes || bytes.length === 0) continue;
    const text = bytes.toString('latin1');
    if (!text.includes('BT') || (!text.includes('Tj') && !text.includes('TJ'))) continue;
    walked++;
    try {
      const walk = walkPage(doc, { dict: new Map([['Contents', obj]]) }, fontCache);
      merged.items.push(...walk.items);
      merged.undecodableRuns += walk.undecodableRuns;
      merged.droppedGlyphs += walk.droppedGlyphs;
      merged.imageCount += walk.imageCount;
    } catch {
      noteLimit(budget, 'malformed');
    }
  }
  merged.charCount = merged.items.reduce((sum, item) => sum + item.text.length, 0);
  return merged.charCount > 0 || merged.undecodableRuns > 0 ? merged : null;
}

/**
 * Pass 2b — the file itself as one content stream.
 *
 * Only for a document that is PLAIN TEXT throughout: small, and effectively all
 * printable bytes. Such a file has no compressed streams to confuse an operator
 * walk, so text operators sitting outside any stream object — hand-written
 * PDFs, generator output that never wrapped its content — are recoverable
 * exactly and without inventing anything. On a real compressed document the
 * sampling gate refuses, which is what keeps binary out of the walk.
 */
function walkWholeSource(
  doc: PdfDoc,
  budget: PdfBudget,
  fontCache: Map<string, PdfFont>,
): PdfPageExtract | null {
  if (doc.src.length > 4 * 1024 * 1024 || !looksLikePlainText(doc.src)) return null;
  if (!doc.src.includes('BT') || (!doc.src.includes('Tj') && !doc.src.includes('TJ'))) return null;
  try {
    const walk = walkPage(doc, { dict: new Map([['Contents', { t: 'stream', v: new Map(), dataStart: 0 }]]) }, fontCache, doc.src);
    const charCount = walk.items.reduce((sum, item) => sum + item.text.length, 0);
    if (charCount === 0 && walk.undecodableRuns === 0) return null;
    return {
      index: 1,
      items: walk.items,
      charCount,
      undecodableRuns: walk.undecodableRuns,
      droppedGlyphs: walk.droppedGlyphs,
      imageCount: walk.imageCount,
      maxImageArea: walk.maxImageArea,
    };
  } catch {
    noteLimit(budget, 'malformed');
    return null;
  }
}

/** Sampled printable-byte ratio — cheap, and enough to tell text from a container. */
function looksLikePlainText(src: string): boolean {
  const step = Math.max(1, Math.floor(src.length / 65_536));
  let printable = 0;
  let total = 0;
  for (let i = 0; i < src.length; i += step) {
    const code = src.charCodeAt(i);
    total++;
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d) printable++;
  }
  return total > 0 && printable / total >= 0.95;
}

/** `/Type /Page` objects, else the page tree's own `/Count`. */
function declaredPageCount(src: string): number | undefined {
  // Bounded quantifiers: this regex runs over attacker-controlled bytes.
  const pageObjects = /\/Type[\x00\t\r\n\f ]{0,8}\/Page(?![a-zA-Z])/g;
  let count = 0;
  while (pageObjects.exec(src) !== null) {
    count++;
    if (count > 100_000) break;
  }
  if (count > 0) return count;
  const declared = /\/Count[\x00\t\r\n\f ]{1,8}(\d{1,7})/.exec(src);
  if (!declared) return undefined;
  const n = Number.parseInt(declared[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extract page count and text from a PDF buffer, capped at `maxChars`
 * (default 20000). Always returns a value — never throws. Empty or unreadable
 * input yields `{ text: '', truncated: false }`.
 */
export function extractPdf(buf: Buffer, opts?: PdfExtractOptions): PdfExtract {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  if (!buf || buf.length === 0) return { text: '', truncated: false };

  let doc: PdfDocumentExtract;
  try {
    doc = extractPdfDocument(buf, opts);
  } catch {
    return { text: '', truncated: false };
  }

  const flat = flattenPdfExtract(buf, doc, opts);
  let text = flat.text;

  let truncated = false;
  if (maxChars >= 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  const result: PdfExtract = { text, truncated };
  if (doc.pageCount !== undefined) result.pageCount = doc.pageCount;
  if (doc.undecodableRuns > 0) result.undecodableRuns = doc.undecodableRuns;
  // The harvest's own walls join the parse's: a caller reading `limits` is
  // asking what stopped us, and "the last resort read part of the file" is one
  // of the answers.
  const limits = mergeLimits(doc.limits, flat.limits);
  if (limits.length > 0) result.limits = limits;
  if (flat.scavenged) result.scavenged = true;
  return result;
}

/**
 * The flat text for a document that has ALREADY been parsed, plus whether it had
 * to be scavenged. A behaviour-identical extraction from `extractPdf`.
 *
 * Split out because ADR-030's routing layer needs both halves of the answer —
 * the per-page structure to classify from, and this flattened text as its
 * fallback — and calling `extractPdf` for the second half would parse the same
 * bytes twice. One parse, two views.
 */
export function flattenPdfExtract(
  buf: Buffer,
  doc: PdfDocumentExtract,
  opts?: PdfExtractOptions,
): FlattenedPdf {
  try {
    const text = flattenDocument(doc);
    if (text.length > 0 || doc.encrypted || !worthScavenging(doc)) return { text, scavenged: false };
    // The harvest gets a budget of its own because it is a loop over
    // attacker-controlled bytes, and it was the only one in this folder without
    // one: `extractPdfDocument` refuses a file over `maxBytes` and returns no
    // pages, and this line used to be handed the very same buffer to scan
    // end-to-end. A 50 MB upload — inside the attachment cap, so accepted —
    // reached 1.9 GB of resident memory here and killed the host process.
    const budget = createBudget(opts?.bounds);
    const reach = Math.min(buf.length, budget.bounds.maxScavengeBytes);
    if (reach < buf.length) noteLimit(budget, 'scavenge');
    const harvested = scavengePrintable(buf.subarray(0, reach).toString('latin1'), budget);
    const result: FlattenedPdf = { text: harvested, scavenged: harvested.length > 0 };
    if (budget.hit.length > 0) result.limits = [...budget.hit];
    return result;
  } catch {
    return { text: '', scavenged: false };
  }
}

/** Union of two limit lists, order preserved, no duplicates. */
export function mergeLimits(a: readonly PdfLimit[], b?: readonly PdfLimit[]): PdfLimit[] {
  const out = [...a];
  for (const limit of b ?? []) if (!out.includes(limit)) out.push(limit);
  return out;
}

/** What `flattenPdfExtract` hands back: the text, its provenance, and any wall it hit. */
export interface FlattenedPdf {
  text: string;
  /** True when the text came from printable runs rather than from page content. */
  scavenged: boolean;
  /** Walls the HARVEST hit — absent when it did not run or hit none. */
  limits?: PdfLimit[];
}

/**
 * Is this a file we failed to read, or a file with nothing to read?
 *
 * A page that drew an image is a page we parsed successfully — it simply has no
 * text layer, which is a scan, and D3's job to say so. Scavenging there does
 * not recover a document; it recovers the producer string out of the trailer
 * and presents it as the contents. So the last resort is reserved for files
 * whose structure told us nothing at all.
 */
function worthScavenging(doc: PdfDocumentExtract): boolean {
  // A file refused for its size was never opened, so there is no failed parse to
  // fall back from — and `pages.every(...)` on the empty array a refusal returns
  // is VACUOUSLY TRUE, which made refusing a file the way to get it scanned.
  // Being told a file is too big has to mean less work, never more.
  if (doc.limits.includes('bytes')) return false;
  return doc.pages.every((page) => page.imageCount === 0 && page.items.length === 0);
}

/** Longest run we keep: past this it is a blob, not a sentence. */
const MAX_RUN_CHARS = 4096;

/**
 * Longest run we will COPY out of the source before rejecting it unread.
 *
 * A run this long cannot trim down under `MAX_RUN_CHARS` unless 94% of it is
 * whitespace, so the span alone settles it and the copy is skipped. The
 * distinction is the whole memory fix: the old loop built every run one
 * character at a time — including the single 50 MB run an all-printable file is
 * — and only then measured it and threw it away.
 */
const MAX_RUN_SPAN = 64 * 1024;

/** Runs, and total characters, we are willing to accumulate. */
const MAX_RUNS = 4096;
const MAX_HARVEST_CHARS = 64_000;

/**
 * Pass 3 — printable ASCII runs, the last resort.
 *
 * Kept for the file that has no usable structure at all, and gated so it cannot
 * do what it used to do: twenty thousand characters of compressed-stream
 * confetti presented to the agent as a document. A run has to look like written
 * language, and the whole harvest has to add up to more than a few words, or
 * the answer is nothing.
 *
 * Runs are tracked as a start index and copied only when their length says they
 * could survive, so the memory this costs is bounded by what it KEEPS rather
 * than by the size of the file it is walking. Pass a budget and the walk also
 * stops at a deadline; without one it runs to the end of the string, which is
 * what a caller holding a few hundred bytes wants.
 */
export function scavengePrintable(src: string, budget?: PdfBudget): string {
  const runs: string[] = [];
  let harvested = 0;
  let start = -1;
  const flush = (end: number): void => {
    const from = start;
    start = -1;
    const span = end - from;
    if (from < 0 || span < 8 || span > MAX_RUN_SPAN) return;
    const trimmed = src.slice(from, end).trim();
    if (trimmed.length < 8 || trimmed.length > MAX_RUN_CHARS) return;
    if (!looksLikeProse(trimmed)) return;
    runs.push(trimmed);
    harvested += trimmed.length + 1;
  };
  for (let i = 0; i < src.length; i++) {
    // Checked on a stride rather than per character: the clock costs more than
    // the comparison it is guarding, and 64k characters is well under a
    // millisecond of overshoot.
    if (budget && (i & 0xffff) === 0 && outOfTime(budget)) break;
    const code = src.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09) {
      if (start < 0) start = i;
      continue;
    }
    flush(i);
    if (runs.length > MAX_RUNS || harvested >= MAX_HARVEST_CHARS) break;
  }
  flush(src.length);
  const joined = runs.join(' ').trim();
  return joined.length >= 24 ? joined : '';
}

/**
 * Does this run read like something a person wrote?
 *
 * Three or more words, mostly letters and spaces, no dictionary syntax, and it
 * does not START with a delimiter. That last rule is the one that earns its
 * keep: `/Filter /FlateDecode` and `(Mac OS X Quartz PDFContext)` both read as
 * prose by every other measure, and both are the file talking about itself.
 * Cheap character counting on purpose — no regex touches this string.
 */
function looksLikeProse(run: string): boolean {
  const first = run[0];
  if (first === '/' || first === '<' || first === '(' || first === '[' || first === '%' || first === '>') {
    return false;
  }
  let letters = 0;
  let spaces = 0;
  let syntax = 0;
  let words = 0;
  let wordLength = 0;
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    const code = run.charCodeAt(i);
    const isLetter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    if (isLetter) {
      letters++;
      wordLength++;
      continue;
    }
    if (wordLength >= 2) words++;
    wordLength = 0;
    if (ch === ' ') {
      spaces++;
      continue;
    }
    if (ch === '/' || ch === '<' || ch === '>' || ch === '[' || ch === ']' || ch === '{' || ch === '}') syntax++;
  }
  if (wordLength >= 2) words++;
  if (words < 3) return false;
  if (syntax > 1) return false;
  const structural = ['obj', 'endobj', 'stream', 'endstream', 'xref', 'trailer', 'startxref', '%PDF', '%%EOF'];
  for (const marker of structural) if (run.startsWith(marker)) return false;
  return (letters + spaces) / run.length >= 0.7;
}
