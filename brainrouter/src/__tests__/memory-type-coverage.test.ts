import { describe, expect, it } from "vitest";
import { COGNITIVE_MEMORY_TYPES } from "@kinqs/brainrouter-types";
import { TYPE_CONFIGS } from "../memory/memory-type-config.js";

// Drift guard: the canonical type list (used by the dashboard /memories
// filter and any other type-enumerating UI) must stay in lockstep with the
// brain's per-type config. If someone adds a MemoryType + TYPE_CONFIGS entry
// but forgets COGNITIVE_MEMORY_TYPES (or vice-versa), this fails loudly.
describe("cognitive memory type coverage", () => {
  it("COGNITIVE_MEMORY_TYPES exactly matches TYPE_CONFIGS keys", () => {
    const canonical = [...COGNITIVE_MEMORY_TYPES].sort();
    const configured = Object.keys(TYPE_CONFIGS).sort();
    expect(canonical).toEqual(configured);
  });

  it("has no duplicates", () => {
    expect(new Set(COGNITIVE_MEMORY_TYPES).size).toBe(COGNITIVE_MEMORY_TYPES.length);
  });
});
