// Barrel for the document concern (ADR-030 D2/D3). The public surface is the
// seam and the shapes it returns; the engine adapter, its bounds and the
// classification rules stay internal so the parser behind them can change
// without a caller noticing — which is the property D2 asks for.
export { parsePdfDocument, documentText, type ParseDocumentOptions } from './parse.js';
export { DOCUMENT_BOUNDS, type DocumentBounds } from './bounds.js';
export { _resetStructuredEngineForTests } from './structured.js';
export type {
  DocumentClassification, DocumentEngine, DocumentPageKind,
  ParsedDocument, ParsedDocumentDiagnostics, ParsedDocumentPage,
} from './types.js';
// ADR-030 Q4 — the stored artifact and its addresses. Exported because the
// resolver, the ingest path and the desktop host all need them; the split rule
// and the on-disk shape stay behind these functions.
export {
  buildDocumentArtifact, documentArtifactPath,
  documentOutlineLabel, documentOutlineRef, documentOutlineState, documentOutlineUri,
  documentPartLabel, documentPartRef, documentPartState, parseDocumentPartId,
  readDocumentArtifact, splitDocumentParts, writeDocumentArtifact,
  DOCUMENT_ARTIFACT_LIMITS, DOCUMENT_ARTIFACT_VERSION, DOCUMENT_MODE,
  type BuildDocumentArtifactInput, type DocumentArtifact, type DocumentOutlineState,
  type DocumentPart, type DocumentPartState,
} from './artifact.js';
