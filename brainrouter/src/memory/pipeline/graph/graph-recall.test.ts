/**
 * The graph block is glued onto EVERY recall response. It was unbounded.
 *
 * A real session (3cbe409e…:new-64b1dcc6…) asked "what is this project about"
 * and got a 154 KB tool result: 4.9 KB of the five records that answered it,
 * and **124 KB of appendSystemContext** — 117 KB of which was this block, 1,835
 * lines of entities and relationships. It then blew past the tool-result clamp,
 * so the model saw an 800-character preview of the graph dump instead of the
 * records, and reasoned from personal context that happened to sit near the top.
 */
import { describe, it, expect } from "vitest";
import {
  expandRecallWithGraph, GRAPH_CONTEXT_MAX_NODES, GRAPH_CONTEXT_MAX_EDGES,
} from "./graph-recall.js";

function storeWith(nodeCount: number, edgesPerNode: number) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`, entity: `Entity${i}`, entityType: "concept",
  }));
  return {
    getAllGraphNodes: async () => nodes,
    getGraphNeighbors: async (_u: string, nodeId: string) => {
      const index = Number(nodeId.slice(1));
      const neighbours = nodes.slice(index, index + edgesPerNode + 1);
      return {
        nodes: neighbours,
        edges: neighbours.slice(1).map((n, j) => ({
          id: `${nodeId}-e${j}`, fromNodeId: nodeId, toNodeId: n.id,
          relation: "relates_to", confidence: 0.5 + (j % 10) / 20,
        })),
      };
    },
  } as never;
}

async function build(nodeCount: number, edgesPerNode: number, query: string) {
  return expandRecallWithGraph({
    topCognitiveResults: [], query, userId: "u1", store: storeWith(nodeCount, edgesPerNode),
  });
}

describe("expandRecallWithGraph", () => {
  it("bounds a large graph and says what it left out", async () => {
    // Every entity name appears in the query, so every node matches — the live case.
    const query = Array.from({ length: 400 }, (_, i) => `Entity${i}`).join(" ");
    const out = await build(400, 6, query);
    const entityLines = out.split("\n").filter((l) => /^- \*\*Entity\d+\*\* \(concept\)$/.test(l));
    expect(entityLines.length).toBe(GRAPH_CONTEXT_MAX_NODES);
    expect(out).toMatch(/…and \d+ further entities/);
    expect(out).toMatch(/memory_graph_query/);
    // 117 KB was the live figure; the bounded block is a fraction of that.
    expect(out.length).toBeLessThan(20_000);
  });

  it("never names an entity it did not show — a dangling edge is a fact about nothing", async () => {
    const query = Array.from({ length: 300 }, (_, i) => `Entity${i}`).join(" ");
    const out = await build(300, 8, query);
    const shown = new Set(
      [...out.matchAll(/^- \*\*(Entity\d+)\*\* \(concept\)$/gm)].map((m) => m[1]),
    );
    for (const [, from, to] of out.matchAll(/^- \*\*(Entity\d+)\*\* --\[[^\]]+\]--> \*\*(Entity\d+)\*\*/gm)) {
      expect(shown.has(from!)).toBe(true);
      expect(shown.has(to!)).toBe(true);
    }
    const edgeLines = [...out.matchAll(/--\[/g)].length;
    expect(edgeLines).toBeLessThanOrEqual(GRAPH_CONTEXT_MAX_EDGES);
  });

  it("a small graph is unchanged — no cap notice, nothing dropped", async () => {
    const out = await build(5, 2, "Entity0 Entity1 Entity2 Entity3 Entity4");
    expect(out).not.toMatch(/…and/);
    expect(out).toMatch(/KNOWLEDGE GRAPH CONTEXT/);
  });

  it("no matching entity means no block at all", async () => {
    expect(await build(50, 3, "nothing here matches")).toBe("");
  });
});
