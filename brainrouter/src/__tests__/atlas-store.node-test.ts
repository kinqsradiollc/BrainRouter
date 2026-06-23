import test from "node:test";
import assert from "node:assert/strict";
import { atlasImpact, atlasSearchMatches, type AtlasGraph } from "@kinqs/brainrouter-types";
import { createTestStore } from "./helpers/pgTestStore.js";

/**
 * REMOTE-BRAIN Phase 3 — the brain persists a client-built Atlas graph per
 * (tenant, workspace) so a remote brain can serve it back. Real Postgres.
 */

function graph(nodeCount: number): AtlasGraph {
  return {
    schemaVersion: 1,
    kind: "codebase",
    project: { name: "demo", languages: ["typescript"], analyzedAt: "2026-06-23T00:00:00Z" },
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `file:f${i}.ts`, type: "file" as const, name: `f${i}.ts`, filePath: `f${i}.ts`,
    })),
    edges: [],
    layers: [],
    tour: [],
  };
}

test("REMOTE-BRAIN atlas store: put → get round-trips; list summarizes; missing → null", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    assert.equal(await store.getAtlasGraph("u1", "ws1"), null);
    assert.deepEqual(await store.listAtlasWorkspaces("u1"), []);

    const g = graph(3);
    await store.putAtlasGraph("u1", "ws1", g);

    const got = await store.getAtlasGraph("u1", "ws1");
    assert.ok(got);
    assert.equal(got!.nodes.length, 3);
    assert.deepEqual(got, g); // exact round-trip

    const list = await store.listAtlasWorkspaces("u1");
    assert.equal(list.length, 1);
    assert.equal(list[0].workspaceTag, "ws1");
    assert.equal(list[0].nodeCount, 3);
    assert.ok(list[0].updatedAt);
  } finally {
    await cleanup();
  }
});

test("REMOTE-BRAIN atlas store: upsert replaces in place; tenant isolation", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.putAtlasGraph("u1", "ws1", graph(2));
    await store.putAtlasGraph("u1", "ws1", graph(5)); // upsert same key

    const got = await store.getAtlasGraph("u1", "ws1");
    assert.equal(got!.nodes.length, 5);

    const list = await store.listAtlasWorkspaces("u1");
    assert.equal(list.length, 1); // still a single row
    assert.equal(list[0].nodeCount, 5);

    // a second workspace coexists
    await store.putAtlasGraph("u1", "ws2", graph(1));
    assert.equal((await store.listAtlasWorkspaces("u1")).length, 2);

    // tenant isolation — u2 sees nothing of u1's graphs
    assert.equal(await store.getAtlasGraph("u2", "ws1"), null);
    assert.deepEqual(await store.listAtlasWorkspaces("u2"), []);
  } finally {
    await cleanup();
  }
});

// Phase 3b — the store→ops path the atlas_query / atlas_impact tools use:
// store a real graph, fetch it, run the shared types ops over it.
test("REMOTE-BRAIN atlas store: query + impact run over the stored graph", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const g: AtlasGraph = {
      schemaVersion: 1,
      kind: "codebase",
      project: { name: "demo", languages: ["typescript"], analyzedAt: "2026-06-23T00:00:00Z" },
      nodes: [
        { id: "file:src/api/server.ts", type: "file", name: "server.ts", filePath: "src/api/server.ts" },
        { id: "file:src/api/routes.ts", type: "file", name: "routes.ts", filePath: "src/api/routes.ts" },
        { id: "file:src/db/store.ts", type: "file", name: "store.ts", filePath: "src/db/store.ts" },
      ],
      edges: [
        { source: "file:src/api/routes.ts", target: "file:src/db/store.ts", type: "imports" },
        { source: "file:src/api/server.ts", target: "file:src/api/routes.ts", type: "imports" },
      ],
      layers: [{ id: "layer:api", name: "API", nodeIds: ["file:src/api/server.ts", "file:src/api/routes.ts"] }],
      tour: [],
    };
    await store.putAtlasGraph("u1", "ws", g);
    const stored = (await store.getAtlasGraph("u1", "ws"))!;

    // query: free-text search ranks the exact name first
    assert.equal(atlasSearchMatches(stored, "store.ts")[0], "file:src/db/store.ts");

    // impact: server.ts → routes.ts → store.ts, so store.ts's transitive
    // dependents are both API files.
    const impact = atlasImpact(stored, "file:src/db/store.ts");
    assert.deepEqual(impact.dependents.sort(), ["file:src/api/routes.ts", "file:src/api/server.ts"]);
    assert.deepEqual(impact.directDependents, ["file:src/api/routes.ts"]);
    assert.deepEqual(impact.byLayer, [{ layer: "API", count: 2 }]);
  } finally {
    await cleanup();
  }
});
