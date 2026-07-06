/**
 * Atlas — codebase knowledge-graph builder (0.4.16).
 *
 * Deterministic pipeline: scan the workspace → extract symbols → assemble the
 * base graph → validate. LLM enrichment (summaries, tags, layers, guided tour)
 * layers on top via {@link enrichAtlasGraph}.
 */
export { scanWorkspace, type ScanResult, type ScannedFile, type ScanOptions } from "./pipeline/scan.js";
export { extractSymbols, type FileSymbols, type ExtractedSymbol, type ExtractedImport } from "./pipeline/extract.js";
export { buildBaseGraph, type BuildOptions } from "./pipeline/buildGraph.js";
export { validateAtlasGraph, type AtlasValidation } from "./pipeline/validate.js";
export { atlasGraphFile, saveAtlasGraph, readAtlasGraph, atlasGraphStats, atlasWorkspaceTag } from "./store/atlasStore.js";
export { enrichAtlasGraph, carryForwardSummaries, type AtlasLlmCaller, type EnrichOptions, type EnrichResult } from "./enrich/enrich.js";
export { buildAtlasChangeContext } from "./changeContext.js";
export { extractAtlasJson, extractAtlasJsonArray } from "./enrich/jsonExtract.js";
