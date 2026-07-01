/**
 * Atlas — codebase knowledge-graph builder (0.4.16).
 *
 * Deterministic pipeline: scan the workspace → extract symbols → assemble the
 * base graph → validate. LLM enrichment (summaries, tags, layers, guided tour)
 * layers on top via {@link enrichAtlasGraph}.
 */
export { scanWorkspace, type ScanResult, type ScannedFile, type ScanOptions } from "./scan.js";
export { extractSymbols, type FileSymbols, type ExtractedSymbol, type ExtractedImport } from "./extract.js";
export { buildBaseGraph, type BuildOptions } from "./buildGraph.js";
export { validateAtlasGraph, type AtlasValidation } from "./validate.js";
export { atlasGraphFile, saveAtlasGraph, readAtlasGraph, atlasGraphStats, atlasWorkspaceTag } from "./atlasStore.js";
export { enrichAtlasGraph, type AtlasLlmCaller, type EnrichOptions, type EnrichResult } from "./enrich.js";
export { extractAtlasJson, extractAtlasJsonArray } from "./jsonExtract.js";
