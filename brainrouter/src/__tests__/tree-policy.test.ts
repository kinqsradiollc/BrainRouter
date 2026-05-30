import { describe, it, expect } from "vitest";
import {
  parentDomain,
  readTreePolicy,
  treeAutobuildEnabled,
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
    expect(readTreePolicy({})).toEqual({ minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6 });
  });

  it("honours valid env overrides", () => {
    expect(
      readTreePolicy({
        BRAINROUTER_TREE_MIN_SCENE_RECORDS: "2",
        BRAINROUTER_TREE_LEAF_PER_PASS: "10",
        BRAINROUTER_TREE_SEAL_THRESHOLD: "4",
      }),
    ).toEqual({ minSceneRecords: 2, leafPerPass: 10, sealThreshold: 4 });
  });

  it("falls back to defaults on invalid / non-positive values", () => {
    expect(
      readTreePolicy({ BRAINROUTER_TREE_LEAF_PER_PASS: "0", BRAINROUTER_TREE_SEAL_THRESHOLD: "abc" }),
    ).toEqual({ minSceneRecords: 3, leafPerPass: 5, sealThreshold: 6 });
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
