/**
 * Atlas LLM enrichment (ATLAS-4).
 *
 * Moved into `@kinqs/brainrouter-types` (REMOTE-BRAIN Phase 3c) so the brain can
 * run enrichment server-side without depending on `core`. Re-exported here so
 * existing `core`/CLI/desktop importers keep working unchanged.
 */
export {
  enrichAtlasGraph,
  carryForwardSummaries,
  type AtlasLlmCaller,
  type EnrichOptions,
  type EnrichResult,
} from "@kinqs/brainrouter-types";
