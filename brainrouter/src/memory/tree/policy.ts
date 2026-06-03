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

/**
 * BRAIN-P4-T5 — topic routing: derive a stable TOPIC bucket key from a scene
 * name, so scenes about the same topic route to the same topic tree (the
 * `topic_curator` step). Strips the `… engineering` suffix that
 * `upsertEngineeringMemory` appends, normalizes, and keeps the leading salient
 * tokens. Pure + deterministic; empty/odd input → "general".
 */
export function topicKeyForScene(sceneName: string): string {
  const key = (sceneName ?? "")
    .replace(/\s+engineering\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return key || "general";
}

export interface TreePolicy {
  /** Min records in a scene before it's worth its own leaf (skip trivial). */
  minSceneRecords: number;
  /** Max leaves built per maintenance pass — bounds work per tick. */
  leafPerPass: number;
  /** Unsealed topic leaves that EAGERLY trigger a seal into the parent domain. */
  sealThreshold: number;
  /**
   * MEM-10b — once a bucket of unsealed topic leaves has *settled* (a
   * maintenance pass added no new leaf), seal it even if it never reached
   * `sealThreshold`. Most users only ever accumulate a handful of distinct
   * mature scenes, so without this floor a bucket of (say) 4 leaves would sit
   * unsealed forever and tree_sealer/tree_digest would never run. Set to a high
   * value to require full buckets; min 1.
   */
  idleSealFloor: number;
  /** BRAIN-P4-T5 — unsealed global-domain roots that trigger a global rollup digest. */
  globalRollupThreshold: number;
}

const DEFAULTS: TreePolicy = { minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6, idleSealFloor: 2, globalRollupThreshold: 3 };

/**
 * Read the (env-overridable) tree-build thresholds. Invalid/blank values fall
 * back to the defaults.
 *   BRAINROUTER_TREE_MIN_SCENE_RECORDS  (default 3)
 *   BRAINROUTER_TREE_LEAF_PER_PASS      (default 5)
 *   BRAINROUTER_TREE_SEAL_THRESHOLD     (default 6)
 *   BRAINROUTER_TREE_IDLE_SEAL_FLOOR    (default 2)
 *   BRAINROUTER_TREE_GLOBAL_ROLLUP      (default 3)
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
    idleSealFloor: num("BRAINROUTER_TREE_IDLE_SEAL_FLOOR", DEFAULTS.idleSealFloor),
    globalRollupThreshold: num("BRAINROUTER_TREE_GLOBAL_ROLLUP", DEFAULTS.globalRollupThreshold),
  };
}

/** Scene-tree autobuild is on unless explicitly disabled (BRAINROUTER_TREE_AUTOBUILD=off). */
export function treeAutobuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BRAINROUTER_TREE_AUTOBUILD ?? "").trim().toLowerCase() !== "off";
}
