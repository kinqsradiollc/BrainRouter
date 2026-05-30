import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageRank, articulationPoints, shortestPath, namespaceOverview, type GraphEdgeLite } from "../memory/graph-analytics.js";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

test("DASH-1 pageRank: a hub accruing in-links outranks leaves; scores ~sum to 1", () => {
  const nodes = ["a", "b", "c", "hub"];
  const edges: GraphEdgeLite[] = [
    { from: "a", to: "hub" }, { from: "b", to: "hub" }, { from: "c", to: "hub" },
  ];
  const pr = pageRank(nodes, edges);
  const total = [...pr.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, "PageRank mass conserved");
  assert.ok(pr.get("hub")! > pr.get("a")!, "the hub is most central");
  assert.equal(pageRank([], []).size, 0);
});

test("DASH-1 articulationPoints: the cut vertex joining two clusters is a bridge", () => {
  // two triangles joined only through `bridge`: x1-x2-x3-bridge-y1-y2-y3
  const nodes = ["x1", "x2", "x3", "bridge", "y1", "y2", "y3"];
  const edges: GraphEdgeLite[] = [
    { from: "x1", to: "x2" }, { from: "x2", to: "x3" }, { from: "x3", to: "x1" },
    { from: "x3", to: "bridge" }, { from: "bridge", to: "y1" },
    { from: "y1", to: "y2" }, { from: "y2", to: "y3" }, { from: "y3", to: "y1" },
  ];
  const cuts = articulationPoints(nodes, edges);
  assert.ok(cuts.includes("bridge"), "the joining node is an articulation point");
  assert.ok(!cuts.includes("x1"), "a triangle member is not a cut vertex");
});

test("DASH-1 shortestPath: BFS over the undirected graph; null when unreachable", () => {
  const nodes = ["a", "b", "c", "d", "island"];
  const edges: GraphEdgeLite[] = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }];
  assert.deepEqual(shortestPath(nodes, edges, "a", "d"), ["a", "b", "c", "d"]);
  assert.deepEqual(shortestPath(nodes, edges, "a", "a"), ["a"]);
  assert.equal(shortestPath(nodes, edges, "a", "island"), null);
  assert.equal(shortestPath(nodes, edges, "a", "nope"), null);
});

test("DASH-1 namespaceOverview: counts by entity type", () => {
  assert.deepEqual(
    namespaceOverview([{ entityType: "module" }, { entityType: "module" }, { entityType: "person" }, { entityType: "" }]),
    { module: 2, person: 1, unknown: 1 },
  );
});

test("DASH-1 engine.graphAnalytics: end-to-end over the store (centrality + bridges + namespaces + path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-dash1-"));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  try {
    const now = "2026-05-31T00:00:00.000Z";
    const mk = (id: string, entity: string, type: string) =>
      store.upsertGraphNode({ id, userId: "u1", entity, entityType: type, skillTag: "", confidence: 0.9, sourceRecordId: "r", createdTime: now });
    const link = (id: string, from: string, to: string) =>
      store.upsertGraphEdge({ id, userId: "u1", fromNodeId: from, toNodeId: to, relation: "rel", skillTag: "", confidence: 0.9, sourceRecordId: "r", createdTime: now });
    mk("n1", "Auth", "module"); mk("n2", "DB", "module"); mk("n3", "Router", "module"); mk("n4", "User", "entity");
    link("e1", "n1", "n3"); link("e2", "n2", "n3"); link("e3", "n4", "n3");

    const engine = new MemoryEngine(store);
    const a = engine.graphAnalytics("u1", { from: "Auth", to: "DB" });
    assert.equal(a.nodeCount, 4);
    assert.equal(a.edgeCount, 3);
    assert.ok(a.topCentral.length > 0);
    assert.equal(a.topCentral[0].entity, "Router", "Router is the hub → top central");
    assert.ok(a.bridges.some((b) => b.entity === "Router"), "Router bridges the others");
    assert.deepEqual(a.namespaces, { module: 3, entity: 1 });
    assert.ok(a.path?.found && a.path.entities.includes("Router"), "Auth→DB routes through Router");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
