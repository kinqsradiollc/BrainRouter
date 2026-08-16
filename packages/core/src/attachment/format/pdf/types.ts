/**
 * ADR-030 D1 — what a parse hands to the layer above it.
 *
 * The shape is positioned runs, not a string, and that is the whole point of
 * doing it now rather than later: reading order, headings and tables are all
 * reconstructed from geometry (§2 of the ADR), and retro-fitting coordinates
 * onto a flattened string means parsing the document a second time.
 *
 * Coordinates are PDF user space — origin at the bottom-left of the page, y
 * increasing UPWARDS — because that is what the file states and converting it
 * here would just hide the convention from the layer that has to know it.
 */
import type { PdfLimit } from './limits.js';

export type { PdfLimit } from './limits.js';
export type { PdfBounds } from './limits.js';

/** One show operation: the text a `Tj`/`TJ`/`'`/`"` put on the page, and where. */
export interface PdfTextItem {
  text: string;
  /** Origin of the run, in user-space units. */
  x: number;
  y: number;
  /** Effective glyph size after the text and current transform matrices. */
  fontSize: number;
  /** `/BaseFont` name, so a later layer can tell a heading face from body text. */
  fontName: string;
  /** Advance width of the run in user-space units — where the run ENDS. */
  width: number;
  /**
   * Set when the run's font supplied no way to establish what its codes mean.
   * `text` is empty for these; they are counted and reported, never guessed at.
   */
  undecodable?: true;
}

export interface PdfPageExtract {
  /** 1-based page number in document order. */
  index: number;
  items: PdfTextItem[];
  /** Characters actually decoded on this page. */
  charCount: number;
  /** Show operations whose font could not be decoded at all. */
  undecodableRuns: number;
  /** Individual codes dropped inside otherwise-decodable runs. */
  droppedGlyphs: number;
  /** Image XObjects drawn on the page — a scanned page is one big one and no text. */
  imageCount: number;
  /**
   * Area of the largest of those images, in user-space units² — the "one big
   * one" the line above names and the count alone cannot express.
   *
   * Compared against `width * height` it says whether a picture IS the page,
   * which is what separates a scanned exhibit carrying a Bates stamp from a
   * cover page carrying a logo. Both have text and an image; only one of them
   * is a document nobody can read.
   */
  maxImageArea: number;
  /** Page size in user-space units, when the document declares a MediaBox. */
  width?: number;
  height?: number;
  /**
   * `/Rotate`, in degrees clockwise, when the page declares one.
   *
   * Carried for the same reason the coordinates are: the runs are in unrotated
   * user space, so a layer that sorts them into reading order without this
   * reads a landscape page sideways — and learning that later means parsing the
   * document a second time.
   */
  rotation?: number;
}

export interface PdfDocumentExtract {
  /** Pages the document claims, even when we walked fewer of them. */
  pageCount?: number;
  pages: PdfPageExtract[];
  /** Bounds we hit; empty when the parse completed within all of them. */
  limits: PdfLimit[];
  undecodableRuns: number;
  /** True when `/Encrypt` made the content ciphertext we do not read. */
  encrypted: boolean;
}

/**
 * The flat, capped view the attachment pipeline has always consumed.
 *
 * The optional fields are absent rather than zero when they have nothing to
 * say, so `{ text: '', truncated: false }` stays exactly that for an empty
 * input — callers (and one long-standing test) compare the whole object.
 */
export interface PdfExtract {
  /** Number of pages, when it could be determined. */
  pageCount?: number;
  /** Extracted text. Empty string when nothing usable could be read. */
  text: string;
  /** Whether `text` was truncated to the `maxChars` cap. */
  truncated: boolean;
  /** Show operations reported as undecodable; absent when there were none. */
  undecodableRuns?: number;
  /** Bounds hit during the parse; absent when none were. */
  limits?: PdfLimit[];
  /**
   * True when the text did NOT come from the page content streams but from
   * printable runs scavenged out of the file — the old behaviour, kept as a
   * last resort and now labelled so the layer above can say so.
   */
  scavenged?: true;
}
