/**
 * PDF-TEXT — the import path for PDF extraction. A re-export barrel; the
 * implementation lives in `./pdf/`.
 *
 * It used to say that FlateDecode "cannot be inflated without a dependency",
 * and everything it did followed from that: no filters, no fonts, and printable
 * ASCII scavenged out of the binary when — which was almost always — nothing
 * else could be found. `node:zlib` is a Node builtin. The sentence was wrong
 * when it was written, and ADR-030 D1 replaces the module it shaped.
 *
 * What callers get now: content streams inflated (Flate with predictors, LZW,
 * ASCIIHex, ASCII85, RunLength), text operators walked with their positions,
 * and characters decoded through the document's own `/ToUnicode` CMaps and
 * encodings — or REPORTED as undecodable when the document supplies no way to
 * establish what its codes mean, because plausible-looking wrong letters are a
 * worse answer than none.
 *
 * The contract is unchanged: `extractPdf` still feeds
 * `AttachmentRecord.extractedText` / `.textTruncated` / `.pageCount`, still caps
 * at `maxChars` (default 20000), still touches no filesystem and no network,
 * and still never throws. `extractPdfDocument` is the same parse without the
 * flattening — pages of positioned runs, for the layer that reconstructs
 * reading order and structure from geometry.
 */
export {
  extractPdf,
  extractPdfDocument,
  flattenPdfExtract,
  mergeLimits,
  scavengePrintable,
  UNDECODABLE_NOTICE_PREFIX,
  PDF_BOUNDS,
  type FlattenedPdf,
  type PdfBounds,
  type PdfDocumentExtract,
  type PdfExtract,
  type PdfExtractOptions,
  type PdfLimit,
  type PdfPageExtract,
  type PdfTextItem,
} from './pdf/index.js';
