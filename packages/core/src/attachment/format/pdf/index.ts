// Barrel for the PDF concern (ADR-030 D1). The public surface is the two
// extractors and the shapes they return; the object grammar, filters, fonts and
// content walk stay internal to the folder so they can change without a caller
// noticing. `format/pdfText.ts` re-exports this and remains the import path.
export {
  extractPdf, extractPdfDocument, flattenPdfExtract, mergeLimits, scavengePrintable,
  type FlattenedPdf, type PdfExtractOptions,
} from './extract.js';
export { UNDECODABLE_NOTICE_PREFIX } from './flatten.js';
export { PDF_BOUNDS } from './limits.js';
export type {
  PdfBounds, PdfDocumentExtract, PdfExtract, PdfLimit, PdfPageExtract, PdfTextItem,
} from './types.js';
