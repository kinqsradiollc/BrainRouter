/**
 * ADR-030 D2/D3 — what one parse of a document hands back.
 *
 * Two engines answer this shape and the caller cannot tell which did: a
 * structured parser that reconstructs headings, columns and tables, and the
 * baseline that inflates streams and walks text operators. That is the point of
 * the seam — D2 says an unavailable parser must produce a WORSE ANSWER, never an
 * error, and a caller that branches on the engine has turned "worse" back into
 * "different", which is the same thing as an error one layer up.
 *
 * The two strings are deliberately separate and must not be merged by accident:
 *
 *  - `markdown` is the DOCUMENT talking. It is attacker-controlled — a PDF can
 *    say "ignore your instructions" in white-on-white text — and every caller
 *    puts it through ADR-029 C4's fence before it reaches a model.
 *  - `notice` is US talking. It is assembled from page numbers, counts and fixed
 *    sentences in this folder; no byte of the document reaches it, which is why
 *    it is the one line a caller may present as its own rather than as data.
 *    In particular the parser reports the document's `/Title`, and we do not use
 *    it: a title is content, and a sentence the reader is meant to believe
 *    cannot contain a string the document chose.
 */
import type { PdfLimit } from '../format/pdf/index.js';

/**
 * What one page is, once we have looked at it.
 *
 * `scanned` and `image` are both "no text layer", split because the remedy
 * differs: a scan needs OCR, a page of vector artwork has no text to find at any
 * effort. `empty` is a page that is genuinely blank — not a failure, and lying
 * about it would send someone looking for text that was never there.
 *
 * There is deliberately no fifth kind for a page whose glyphs could not be
 * decoded. Such a page HAS a text layer, so it is `text`, and the baseline
 * writes `[unreadable page N: …]` on the line itself. Calling it a scan would
 * change what the reader does — they would go looking for OCR when what is
 * missing is a font's Unicode mapping.
 */
export type DocumentPageKind = 'text' | 'scanned' | 'image' | 'empty';

/**
 * What the whole document is. The ADR's four, plus the honest fifth.
 *
 * `unreadable` is not one of §3's kinds because §3 describes what a document
 * IS; this one describes a refusal — encrypted, malformed, or over a bound. It
 * exists so a caller never has to read "text, and the text is empty" and guess
 * which of those two happened.
 */
export type DocumentClassification = 'text' | 'scanned' | 'image' | 'mixed' | 'unreadable';

export interface ParsedDocumentPage {
  /** 1-based page number in document order. */
  index: number;
  kind: DocumentPageKind;
}

/** Which engine produced a given part of the answer. */
export type DocumentEngine = 'structured' | 'baseline' | 'none';

/**
 * Facts about HOW the answer was produced, kept apart from the answer itself.
 *
 * Separated into its own object rather than spread across `ParsedDocument`
 * because of the rule above: no caller routes on these. They exist for
 * telemetry, for tests that must prove the fallback path actually runs, and for
 * a person debugging why a document read badly.
 */
export interface ParsedDocumentDiagnostics {
  /** Engine whose text is in `markdown`. `none` when there is no text at all. */
  textFrom: DocumentEngine;
  /** Engine whose verdict is in `pages`. */
  classifiedBy: 'structured' | 'baseline';
  /**
   * Why the structured engine did not answer. Absent when it did.
   *
   * A sentence, because the reasons are not a closed set: the module may be
   * missing from the install, the file may be over the engine's byte cap, the
   * deadline may have passed, or the parser itself may have refused the file.
   */
  structureUnavailable?: string;
  /** Wall-clock spent inside the seam. */
  elapsedMs: number;
}

export interface ParsedDocument {
  classification: DocumentClassification;
  /** Per-page verdicts for the pages we have information about. */
  pages: ParsedDocumentPage[];
  /** Pages the document has, when it could be established. */
  pageCount?: number;
  /** The document's own words. UNTRUSTED. Empty when there were none. */
  markdown: string;
  /** True when `markdown` was cut to the caller's cap. */
  truncated: boolean;
  /**
   * Our sentence about the DOCUMENT: that it is a scan, which pages are, that it
   * is encrypted, that the text was harvested rather than parsed.
   *
   * Empty when nothing needs saying — a notice that always appears is a notice
   * the model learns to skip, and then it is not there on the day a scanned
   * appendix arrives.
   */
  notice: string;
  /**
   * Our sentence about OUR MACHINERY: that the structured parser did not answer,
   * so the text is unstructured. D2 requires this line to reach the agent.
   *
   * Split from `notice` because the two have different audiences and different
   * lifetimes. "This is a scan" is a durable fact about the file and belongs
   * wherever the file is stored; "our parser was unavailable today" is a fact
   * about this run, and writing it into a stored document body would bake a
   * transient condition into the row's content hash and into every search that
   * ever matches it. A caller with one field takes `notice`; a caller rendering
   * a turn takes both.
   */
  structureNote: string;
  /** Bounds hit during the parse; empty when none were. */
  limits: PdfLimit[];
  diagnostics: ParsedDocumentDiagnostics;
}
