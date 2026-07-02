/**
 * Atlas panel — pure view helpers (ATLAS-5) — barrel.
 *
 * Turns an AtlasGraph into a renderable, bounded set of file-level nodes +
 * import edges, assigns theme-consistent colours by node type, computes
 * force-directed / grid layouts, and derives the Overview / Domain / Service /
 * Review / coverage / stats models. Kept pure (no React, no DOM) so it
 * unit-tests under tsx and the panel stays thin.
 *
 * The implementation now lives in the cohesive `./atlasView/*` sibling modules
 * (split by concern); this file re-exports their public surface unchanged so
 * every existing importer + test keeps importing from `atlasView` as before.
 */

// Pure query + impact ops moved to the shared `types` package (REMOTE-BRAIN
// Phase 3b) so the brain can reuse them server-side. Re-exported here so the
// panel + existing tests keep importing them from atlasView unchanged.
// Import from the atlas-ops SUBPATH, not the package barrel: the barrel's
// `export *` pulls `memory.js`, whose top-level `node:crypto` import breaks the
// browser (vite) bundle. atlas-ops only depends on the pure `atlas.js` types.
export { atlasSearchMatches, atlasImpact, atlasImpactOf, type AtlasImpact } from "@kinqs/brainrouter-types/dist/atlas-ops.js";

// Node-type + file-category colours.
export { ATLAS_NODE_COLORS, atlasNodeColor, ATLAS_FILE_CATEGORIES, ATLAS_CATEGORY_COLORS } from "./atlasView/colors.js";

// Bounded structural view model + force-directed layout.
export { atlasViewModel, atlasLayout, atlasNodeSize, type AtlasViewNode, type AtlasViewModel } from "./atlasView/viewModel.js";

// Detail-panel facts for one node.
export { atlasNodeFacts, type AtlasSymbolRef, type AtlasNodeFacts } from "./atlasView/nodeFacts.js";

// Grouped structural view (ATLAS-10) — grouping + capping + grid pack.
export {
  atlasGrouping, capAtlasGroups, atlasGroupedLayout,
  type AtlasGroup, type AtlasGroupBox, type AtlasGroupedLayout, type GroupedLayoutOpts,
} from "./atlasView/grouping.js";

// Overview mode — layer cards + inter-layer edges.
export { atlasOverviewModel, ATLAS_OVERVIEW_OTHER_ID, type AtlasOverviewCard, type AtlasOverviewModel } from "./atlasView/overview.js";

// Review overlay (ATLAS-11) — git working-tree changes on the graph.
export {
  atlasChangeKind, atlasChangeMap, atlasNodeChanges,
  type AtlasChangeKind, type AtlasChangeAssessment,
} from "./atlasView/changes.js";

// Domain deep-dive (ATLAS-12) — capabilities view.
export { atlasDomainModel, type AtlasDomainCard, type AtlasDomainModel } from "./atlasView/domain.js";

// Test coverage (ATLAS-15).
export { isTestFile, atlasUncoveredFiles } from "./atlasView/coverage.js";

// Service map (ADR-008, Wave 3).
export {
  isServicePortPath, serviceModuleLabel, atlasServiceModel,
  type AtlasServiceCard, type AtlasServiceModel,
} from "./atlasView/service.js";

// Project stats (Deep Dive).
export { atlasProjectStats, type AtlasProjectStats } from "./atlasView/stats.js";
