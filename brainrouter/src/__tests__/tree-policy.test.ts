import { describe, it, expect } from "vitest";
import {
  parentDomain,
  readTreePolicy,
  treeAutobuildEnabled,
  topicKeyForScene,
  SCENE_LEAF_DOMAIN,
} from "../memory/tree/policy.js";

/**
 * MEM-20 (0.4.4) — tree domain policy (kept separate from the generic tree
 * mechanics). Encodes the source → topic → global seal hierarchy, the
 * scene-leaf domain, and the env-overridable build thresholds.
 */

describe("tree domain policy", () => {
  it("seals source → topic → global, with global capping", () => {
    expect(parentDomain("source")).toBe("topic");
    expect(parentDomain("topic")).toBe("global");
    expect(parentDomain("global")).toBe("global");
  });

  it("scene leaves are topic-domain and seal into global", () => {
    expect(SCENE_LEAF_DOMAIN).toBe("topic");
    expect(parentDomain(SCENE_LEAF_DOMAIN)).toBe("global");
  });
});

describe("readTreePolicy", () => {
  it("defaults to 3 / 5 / 6 with no env", () => {
    expect(readTreePolicy({})).toEqual({ minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6, globalRollupThreshold: 3 });
  });

  it("honours valid env overrides", () => {
    expect(
      readTreePolicy({
        BRAINROUTER_TREE_MIN_SCENE_RECORDS: "2",
        BRAINROUTER_TREE_LEAF_PER_PASS: "10",
        BRAINROUTER_TREE_SEAL_THRESHOLD: "4",
        BRAINROUTER_TREE_GLOBAL_ROLLUP: "5",
      }),
    ).toEqual({ minSceneRecords: 2, leafPerPass: 10, sealThreshold: 4, globalRollupThreshold: 5 });
  });

  it("falls back to defaults on invalid / non-positive values", () => {
    expect(
      readTreePolicy({ BRAINROUTER_TREE_LEAF_PER_PASS: "0", BRAINROUTER_TREE_SEAL_THRESHOLD: "abc" }),
    ).toEqual({ minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6, globalRollupThreshold: 3 });
  });
});

describe("topicKeyForScene (BRAIN-P4-T5)", () => {
  it("strips the engineering suffix + normalizes to a topic bucket", () => {
    expect(topicKeyForScene("Auth refactor engineering")).toBe("auth refactor");
    expect(topicKeyForScene("scene0 engineering")).toBe("scene0");
  });

  it("routes scenes about the same topic to the same key", () => {
    expect(topicKeyForScene("Recall pipeline tuning engineering")).toBe(topicKeyForScene("recall pipeline tuning"));
  });

  it("caps at 3 salient tokens; empty/odd input → general", () => {
    expect(topicKeyForScene("a b c d e")).toBe("a b c");
    expect(topicKeyForScene("")).toBe("general");
    expect(topicKeyForScene("   ")).toBe("general");
  });
});

describe("treeAutobuildEnabled", () => {
  it("is on by default and only 'off' disables it", () => {
    expect(treeAutobuildEnabled({})).toBe(true);
    expect(treeAutobuildEnabled({ BRAINROUTER_TREE_AUTOBUILD: "on" })).toBe(true);
    expect(treeAutobuildEnabled({ BRAINROUTER_TREE_AUTOBUILD: "OFF" })).toBe(false);
    expect(treeAutobuildEnabled({ BRAINROUTER_TREE_AUTOBUILD: " off " })).toBe(false);
  });
});
