import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { digestTreeNodes } from "../memory/tree/digest.js";
import { getJobExecutor } from "../memory/scheduler/executors.js";

/**
 * 0.4.3 (MEM-10) — tree_digest: LLM re-summary of memory-tree parents, and the
 * tree_sealer → tree_digest auto-chain.
 */

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-digest-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A parent (level 1) over two leaf children, with a deterministic summary. */
function makeParent(store: SqliteMemoryStore, userId: string) {
  const c1 = store.appendTreeNode(userId, { kind: "topic", level: 0, summaryMd: "child one: auth route leaks the api key" });
  const c2 = store.appendTreeNode(userId, { kind: "topic", level: 0, summaryMd: "child two: recall fuses fts and vector" });
  const parent = store.appendTreeNode(userId, { kind: "global", level: 1, summaryMd: "deterministic: child one... child two..." });
  store.setTreeParent([c1.id, c2.id], parent.id);
  return parent;
}

test("digestTreeNodes: replaces the parent summary with the LLM output", async () => {
  const { store, cleanup } = fresh("apply");
  try {
    const parent = makeParent(store, "u1");
    const r = await digestTreeNodes({
      userId: "u1",
      nodeIds: [parent.id],
      store,
      llmRunner: { run: async () => "Auth and recall: a route leaks the API key; recall fuses FTS + vector." },
    });
    assert.deepEqual(r.summarized, [parent.id]);
    assert.equal(r.skipped, 0);
    assert.match(store.getTreeNode(parent.id)!.summaryMd, /leaks the API key; recall fuses FTS/);
  } finally {
    cleanup();
  }
});

test("digestTreeNodes: LLM failure keeps the deterministic summary (graceful)", async () => {
  const { store, cleanup } = fresh("fail");
  try {
    const parent = makeParent(store, "u1");
    const before = store.getTreeNode(parent.id)!.summaryMd;
    const r = await digestTreeNodes({
      userId: "u1",
      nodeIds: [parent.id],
      store,
      llmRunner: { run: async () => { throw Object.assign(new Error("LLM not configured"), { code: "LLM_NOT_CONFIGURED" }); } },
    });
    assert.deepEqual(r.summarized, []);
    assert.equal(r.skipped, 1);
    assert.equal(store.getTreeNode(parent.id)!.summaryMd, before, "deterministic summary preserved on LLM failure");
  } finally {
    cleanup();
  }
});

test("digestTreeNodes: skips foreign-user nodes + childless nodes", async () => {
  const { store, cleanup } = fresh("skip");
  try {
    const parent = makeParent(store, "u1");
    const childless = store.appendTreeNode("u1", { kind: "global", level: 1, summaryMd: "no children" });
    const runner = { run: async () => "should not be applied" };
    // foreign user
    assert.equal((await digestTreeNodes({ userId: "other", nodeIds: [parent.id], store, llmRunner: runner })).skipped, 1);
    // childless parent
    assert.equal((await digestTreeNodes({ userId: "u1", nodeIds: [childless.id], store, llmRunner: runner })).skipped, 1);
  } finally {
    cleanup();
  }
});

test("tree_sealer auto-chains a tree_digest job for the sealed parent", async () => {
  const { store, cleanup } = fresh("chain");
  try {
    // Real store for the enqueue; fake engine for summarizeBucket.
    const fakeEngine = { summarizeBucket: () => ({ id: "tree_parent_xyz" }) } as never;
    const ctx = { store, llmRunner: { run: async () => "" }, engine: fakeEngine } as never;
    const out = await getJobExecutor("tree_sealer")!({ userId: "u1", childIds: ["a", "b"], kind: "global" }, ctx);
    assert.equal((out as { parentId: string }).parentId, "tree_parent_xyz");

    const jobs = store.listMemoryJobs({ kind: "tree_digest", status: ["pending", "running"] }) as Array<{ input?: { nodeIds?: string[]; userId?: string } }>;
    assert.equal(jobs.length, 1, "one tree_digest job enqueued");
    assert.deepEqual(jobs[0].input?.nodeIds, ["tree_parent_xyz"]);
    assert.equal(jobs[0].input?.userId, "u1");
  } finally {
    cleanup();
  }
});
