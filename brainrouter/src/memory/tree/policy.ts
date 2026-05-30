/**
 * MEM-20 (0.4.4) — memory-tree domain POLICY, kept deliberately separate from
 * the generic tree MECHANICS in `tree.ts` (parentLevel / aggregateChunkIds /
 * summarizeChildren / aggregateHeat). Mechanics are "how to seal/aggregate";
 * policy is "which domain a node belongs to, and the thresholds that drive the
 * build/seal schedule".
 *
 * The tree has three domains:
 *   - **source** — one tree per source document (file, transcript, imported
 *     doc); leaves are that source's chunks. Built at ingestion time (not by the
 *     scene autobuild). Seals upward into a topic.
 *   - **topic**  — one tree per topic/scene; leaves are scene-grouped record
 *     digests. This is what the scene autobuild grows. Seals into global.
 *   - **global** — cross-topic rollup digests; the top of the hierarchy.
 *
 * Seal hierarchy: source → topic → global (global caps). The scene autobuild
 * thus grows TOPIC leaves and seals a full bucket into a GLOBAL parent. Topic
 * routing of arbitrary chunks and source-tree autobuild are future work; this
 * module is the single place that policy lives so they can plug in here.
 */
import type { MemoryTreeKind } from "@kinqs/brainrouter-types";

export type TreeDomain = MemoryTreeKind; // "source" | "topic" | "global"

/** The parent domain a child node seals INTO. global is the top (caps). */
export function parentDomain(child: TreeDomain): TreeDomain {
  switch (child) {
    case "source":
      return "topic";
    case "topic":
      return "global";
    case "global":
      return "global";
  }
}

/** Scene-grouped cognitive-record leaves are TOPIC-domain (one topic per scene). */
export const SCENE_LEAF_DOMAIN: TreeDomain = "topic";

export interface TreePolicy {
  /** Min records in a scene before it's worth its own leaf (skip trivial). */
  minSceneRecords: number;
  /** Max leaves built per maintenance pass — bounds work per tick. */
  leafPerPass: number;
  /** Unsealed topic leaves that trigger a seal into the parent domain. */
  sealThreshold: number;
}

const DEFAULTS: TreePolicy = { minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6 };

/**
 * Read the (env-overridable) tree-build thresholds. Invalid/blank values fall
 * back to the defaults.
 *   BRAINROUTER_TREE_MIN_SCENE_RECORDS  (default 3)
 *   BRAINROUTER_TREE_LEAF_PER_PASS      (default 5)
 *   BRAINROUTER_TREE_SEAL_THRESHOLD     (default 6)
 */
export function readTreePolicy(env: NodeJS.ProcessEnv = process.env): TreePolicy {
  const num = (name: string, def: number, min = 1): number => {
    const v = Number.parseInt(env[name] ?? "", 10);
    return Number.isInteger(v) && v >= min ? v : def;
  };
  return {
    minSceneRecords: num("BRAINROUTER_TREE_MIN_SCENE_RECORDS", DEFAULTS.minSceneRecords),
    leafPerPass: num("BRAINROUTER_TREE_LEAF_PER_PASS", DEFAULTS.leafPerPass),
    sealThreshold: num("BRAINROUTER_TREE_SEAL_THRESHOLD", DEFAULTS.sealThreshold),
  };
}

/** Scene-tree autobuild is on unless explicitly disabled (BRAINROUTER_TREE_AUTOBUILD=off). */
export function treeAutobuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BRAINROUTER_TREE_AUTOBUILD ?? "").trim().toLowerCase() !== "off";
}
