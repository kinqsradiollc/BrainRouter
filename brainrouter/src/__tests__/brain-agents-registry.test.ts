import { describe, expect, it } from "vitest";
import { listBrainAgents, findBrainAgentById } from "../memory/agents/registry.js";

// The IDs + modelClass are frozen in brain-agents.md (BRAIN-DESIGN-T1).
// Dashboard / CLI consumers hard-code them, so this test guards drift.
const EXPECTED = [
  { id: "cognitive_extractor", modelClass: "extraction", dependsOn: [] },
  { id: "memory_deduper", modelClass: "judge", dependsOn: ["cognitive_extractor"] },
  { id: "contradiction_checker", modelClass: "judge", dependsOn: ["cognitive_extractor"] },
  { id: "graph_extractor", modelClass: "extraction", dependsOn: ["cognitive_extractor"] },
  { id: "focus_shift_judge", modelClass: "judge", dependsOn: ["cognitive_extractor"] },
  { id: "focus_distiller", modelClass: "synthesis", dependsOn: ["focus_shift_judge"] },
  { id: "identity_distiller", modelClass: "synthesis", dependsOn: ["cognitive_extractor"] },
  { id: "relevance_judge", modelClass: "judge", dependsOn: [] },
  // 0.4.3 (MEM-10) — depth-pipeline agents
  { id: "source_chunker", modelClass: "none", dependsOn: [] },
  { id: "blackboard_reconciler", modelClass: "none", dependsOn: [] },
  { id: "tree_sealer", modelClass: "none", dependsOn: [] },
  { id: "tree_digest", modelClass: "synthesis", dependsOn: ["tree_sealer"] },
  { id: "vault_exporter", modelClass: "none", dependsOn: [] },
  { id: "benchmark_eval", modelClass: "none", dependsOn: [] },
];

describe("brain agent registry", () => {
  it("registers exactly the eight locked built-in agents", () => {
    const ids = listBrainAgents().map((a) => a.id);
    expect(ids).toEqual(EXPECTED.map((e) => e.id));
  });

  it("matches the frozen modelClass + dependsOn contract", () => {
    for (const e of EXPECTED) {
      const agent = findBrainAgentById(e.id);
      expect(agent, `agent ${e.id} present`).toBeDefined();
      expect(agent!.modelClass).toBe(e.modelClass);
      expect(agent!.dependsOn).toEqual(e.dependsOn);
    }
  });

  it("every dependsOn edge points at a known agent", () => {
    const ids = new Set(listBrainAgents().map((a) => a.id));
    for (const agent of listBrainAgents()) {
      for (const dep of agent.dependsOn) {
        expect(ids.has(dep), `${agent.id} depends on known ${dep}`).toBe(true);
      }
    }
  });

  it("findBrainAgentById returns undefined for unknown ids", () => {
    expect(findBrainAgentById("nope")).toBeUndefined();
  });

  it("idempotencyKey is a pure, stable function of input ids", () => {
    const extractor = findBrainAgentById("cognitive_extractor")!;
    const k1 = extractor.idempotencyKey({ sensoryIds: ["b", "a"] });
    const k2 = extractor.idempotencyKey({ sensoryIds: ["a", "b"] });
    expect(k1).toBe(k2); // order-independent
    expect(k1).toBe("extract:a,b");
    // Empty / missing ids ⇒ no in-flight dedup.
    expect(extractor.idempotencyKey({})).toBe("");
    // relevance_judge opts out of dedup entirely.
    expect(findBrainAgentById("relevance_judge")!.idempotencyKey({ query: "x" })).toBe("");
  });

  it("listBrainAgents returns a fresh array (callers can't mutate the registry)", () => {
    const first = listBrainAgents();
    first.push({} as any);
    expect(listBrainAgents()).toHaveLength(14);
  });
});
