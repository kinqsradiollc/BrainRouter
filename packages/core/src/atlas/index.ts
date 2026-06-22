/**
 * Atlas — codebase knowledge-graph builder (0.4.16).
 *
 * Deterministic pipeline: scan the workspace → extract symbols → assemble the
 * base graph → validate. LLM enrichment (summaries, semantic edges, layers,
 * tour) layers on top in a later slice.
 */
export { scanWorkspace, type ScanResult, type ScannedFile, type ScanOptions } from "./scan.js";
export { extractSymbols, type FileSymbols, type ExtractedSymbol, type ExtractedImport } from "./extract.js";
export { buildBaseGraph, type BuildOptions } from "./buildGraph.js";
export { validateAtlasGraph, type AtlasValidation } from "./validate.js";
