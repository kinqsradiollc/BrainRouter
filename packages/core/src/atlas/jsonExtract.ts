/**
 * Atlas LLM-output JSON extraction.
 *
 * Moved into `@kinqs/brainrouter-types` (REMOTE-BRAIN Phase 3c) so the brain can
 * reuse it server-side without depending on `core`. Re-exported here so existing
 * `core`/CLI/desktop importers keep working unchanged.
 */
export { extractAtlasJson, extractAtlasJsonArray } from "@kinqs/brainrouter-types";
