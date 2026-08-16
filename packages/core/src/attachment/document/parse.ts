/**
 * ADR-030 D2/D3 — THE SEAM. Bytes in, a document out, one way in for everyone.
 *
 * Everything that reads a PDF calls `parsePdfDocument` and nothing else: the
 * attachment pipeline (`attachment/ingest/ingest.ts`), the hosted knowledge
 * ingest (`brainrouter/src/knowledge/services/documents.ts`), and whatever comes
 * after them. No caller knows, or is able to find out without asking
 * diagnostics, which of the two engines answered — that is D2's rule, and it is
 * what lets the parser be missing on a machine without any of those callers
 * growing a second code path.
 *
 * The order is not an optimisation, it is the guarantee:
 *
 *  1. **The baseline runs first, always.** It never throws and it is bounded by
 *     its own budget, so by the time the structured engine is even attempted we
 *     already hold an answer we can ship. D2: *a document parser that is
 *     unavailable must produce a worse answer, never an error.*
 *  2. **The structured engine is attempted inside walls** (`bounds.ts`), and
 *     every way it can fail returns a reason rather than throwing.
 *  3. **The two are merged** rather than one replacing the other: structure from
 *     the engine, the per-page character counts that check it from the baseline,
 *     and — when the engine classifies a document as unreadable but the baseline
 *     decoded real text from part of it — the baseline's text.
 *  4. **The verdict is stated** (`classify.ts`). A scan says it is a scan. This
 *     is the step §6 says the whole ADR is judged on.
 *
 * What this does NOT do, deliberately: it does not turn the document into an
 * addressable artifact. Q4 says the 20,000-character cap should stop being the
 * whole answer, with the rest reachable at a `brainrouter://` reference; this
 * still returns one capped string, and `ParsedDocument.pages` is the shape that
 * work will hang off.
 */
import {
  extractPdfDocument, flattenPdfExtract, mergeLimits, type PdfBounds, type PdfLimit,
} from '../format/pdf/index.js';
import { resolveDocumentBounds, type DocumentBounds } from './bounds.js';
import { classifyDocument, renderNotice, renderStructureNote } from './classify.js';
import { runStructured, type StructuredResult } from './structured.js';
import type { ParsedDocument } from './types.js';

/** The cap the attachment pipeline has always applied. */
const DEFAULT_MAX_CHARS = 20_000;

export interface ParseDocumentOptions {
  /** Cap on the returned Markdown. Negative disables the cap. */
  maxChars?: number;
  /** Override the structured engine's walls — the defaults are the shipping ones. */
  bounds?: Partial<DocumentBounds>;
  /** Override the baseline parser's walls. */
  pdfBounds?: Partial<PdfBounds>;
  /**
   * Set false to answer from the baseline alone.
   *
   * Exists so a test can prove the degraded path produces a worse answer rather
   * than an error — which is the property D2 actually asks for, and the one that
   * cannot be checked by uninstalling a package in CI.
   */
  useStructuredEngine?: boolean;
}

/**
 * Parse a PDF into text, a per-page classification, and an honest sentence about
 * what could not be read.
 *
 * Never throws and never rejects. Anything that goes wrong — a hostile file, a
 * missing parser, a spent budget — comes back as a degraded answer with a
 * reason, because this sits on an upload path and a parser bug must cost an
 * attachment its structure, not its existence.
 */
export async function parsePdfDocument(
  bytes: Buffer,
  opts?: ParseDocumentOptions,
): Promise<ParsedDocument> {
  const started = Date.now();
  const bounds = resolveDocumentBounds(opts?.bounds);
  const deadline = started + bounds.timeBudgetMs;
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;

  const floor = extractPdfDocument(bytes ?? Buffer.alloc(0), { bounds: opts?.pdfBounds });
  const floorText = bytes && bytes.length > 0
    ? flattenPdfExtract(bytes, floor, { bounds: opts?.pdfBounds })
    : { text: '', scavenged: false };
  // The baseline's walls are the parse's AND the harvest's. Kept together from
  // here on: `textLimits` below reports the walls that shaped the text we
  // return, and when that text was harvested, the harvest's walls are them.
  const floorLimits = mergeLimits(floor.limits, floorText.limits);

  const limits: PdfLimit[] = [...floorLimits];
  let structured: StructuredResult | null = null;
  let structureUnavailable: string | undefined;
  let pagesCapped = false;

  // An encrypted body is ciphertext to both engines, and we hold no password.
  // Skipping the attempt saves reading 4.6 MB off disk to be told what the
  // baseline has already established.
  const attempt = opts?.useStructuredEngine !== false && !floor.encrypted && !!bytes && bytes.length > 0;
  if (attempt) {
    const outcome = await runStructured(bytes, {
      deadline,
      maxBytes: bounds.maxBytes,
      maxPages: bounds.maxPages,
      canaryFraction: bounds.canaryFraction,
      maxMemoryBytes: bounds.maxMemoryBytes,
    });
    if (outcome.ok) {
      structured = outcome.result;
      pagesCapped = outcome.pagesCapped;
      if (pagesCapped && !limits.includes('pages')) limits.push('pages');
    } else {
      structureUnavailable = outcome.reason;
      if (outcome.limit && !limits.includes(outcome.limit)) limits.push(outcome.limit);
    }
  } else if (opts?.useStructuredEngine === false) {
    structureUnavailable = 'the structured parser was not used';
  } else if (floor.encrypted) {
    structureUnavailable = 'the document is encrypted';
  }

  const classified = classifyDocument({ floor, structured, maxPages: bounds.maxPages });

  // The engine's Markdown wins when it has any, because structure is the reason
  // it exists. It reports none for a document it judges to be a scan — and that
  // judgement is per-document, so a mixed file whose readable half the baseline
  // DID decode falls through to the baseline's text rather than to nothing.
  const structuredMarkdown = (structured?.markdown ?? '').trim();
  let markdown = structuredMarkdown;
  let textFrom: 'structured' | 'baseline' | 'none' = structuredMarkdown ? 'structured' : 'none';
  if (!markdown && floorText.text) {
    markdown = floorText.text;
    textFrom = 'baseline';
  }

  let truncated = false;
  if (maxChars >= 0 && markdown.length > maxChars) {
    markdown = markdown.slice(0, maxChars);
    truncated = true;
  }

  const pageCount = structured?.pageCount ?? floor.pageCount;
  // Only the walls that shaped the text we are actually returning. See
  // `NoticeInput.limits` for why the union would produce a false sentence.
  const textLimits = textFrom === 'structured'
    ? (pagesCapped ? (['pages'] as PdfLimit[]) : [])
    : floorLimits;
  const notice = renderNotice({
    classification: classified.classification,
    pages: classified.pages,
    pageCount,
    encrypted: floor.encrypted,
    limits: textLimits,
    scavenged: floorText.scavenged && textFrom === 'baseline',
    hasText: markdown.length > 0,
    // Only when we recovered NOTHING. With text in hand the structure note
    // already says the right thing, and repeating it would make every
    // baseline-answered document lead with a failure it survived.
    ...(markdown.length === 0 && structureUnavailable ? { structureUnavailable } : {}),
  });

  const result: ParsedDocument = {
    classification: classified.classification,
    pages: classified.pages,
    markdown,
    truncated,
    notice,
    structureNote: renderStructureNote(structureUnavailable, markdown.length > 0),
    limits,
    diagnostics: {
      textFrom,
      classifiedBy: classified.classifiedBy,
      elapsedMs: Date.now() - started,
    },
  };
  if (pageCount !== undefined) result.pageCount = pageCount;
  if (structureUnavailable) result.diagnostics.structureUnavailable = structureUnavailable;
  return result;
}

/**
 * The parse as ONE string, for a caller that has exactly one field to put it in.
 *
 * The hosted knowledge store is such a caller: a document row has a body and
 * nowhere else to say "this is a scan", and dropping the sentence would store a
 * scanned contract as an empty document. A caller with somewhere better to put
 * the notice — outside the untrusted-content fence, where a sentence in our own
 * voice belongs — should use the fields separately instead.
 *
 * `structureNote` is deliberately NOT included: it is about this run of our
 * parser, and a stored row must not carry a transient condition in its body (see
 * `ParsedDocument.structureNote`).
 */
export function documentText(parsed: ParsedDocument): string {
  if (!parsed.notice) return parsed.markdown;
  if (!parsed.markdown) return parsed.notice;
  return `${parsed.notice}\n\n${parsed.markdown}`;
}
