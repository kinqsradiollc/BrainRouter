/**
 * Scope preference end to end: a real Postgres store, the real engine, and the
 * `recallWithDecorations` layer every caller actually goes through. The unit
 * tests mock the engine or drive the pipeline directly, so none of them could
 * see a layer in between drop the scope — this one can.
 *
 * Runs under `node --test` against the docker pgvector (see pgTestStore.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { createTestEngine } from "./helpers/pgTestStore.js";

const FOLDER = workspaceTagFromPath("/repos/widget")!;       // chat turns in this checkout
const REPO = "abcdef0123456789";                              // this checkout's ingested files
const ELSEWHERE = workspaceTagFromPath("/repos/other-app")!;  // a different repository

function record(id: string, workspaceTag: string | undefined, sessionKey = "sk-old"): any {
  return {
    id,
    userId: "u1",
    sessionKey,
    sessionId: "sid-1",
    content: `the widget ledger reconciles invoices nightly (${id})`,
    type: "codebase_fact",
    priority: 50,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    invalidAt: null,
    timestampStr: "2026-09-01",
    timestampStart: "2026-09-01T00:00:00Z",
    timestampEnd: "2026-09-01T00:00:00Z",
    createdTime: "2026-09-01T00:00:00Z",
    updatedTime: "2026-09-01T00:00:00Z",
    metadata: {},
    confidence: 0.7,
    status: "active",
    sourceKind: "",
    verificationStatus: "",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
    ...(workspaceTag ? { workspaceTag } : {}),
  };
}

test("a real recall ranks this workspace first under either identity, labels the rest, hides nothing", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const store = (engine as unknown as { store: { upsertCognitive(r: unknown): Promise<unknown> } }).store;
    await store.upsertCognitive(record("rec-elsewhere", ELSEWHERE));
    await store.upsertCognitive(record("rec-ingested", REPO));
    await store.upsertCognitive(record("rec-legacy", undefined));
    await store.upsertCognitive(record("rec-chat", FOLDER));
    await store.upsertCognitive(record("rec-now", FOLDER, "sk-now"));

    const result = await engine.recall({
      userId: "u1",
      sessionKey: "sk-now",
      query: "widget ledger reconciles invoices",
      limitsOverride: { topResults: 10 },
      preferScope: { sessionKey: "sk-now", workspaceTags: [FOLDER, REPO] },
    });

    const hits = result.recalledCognitiveMemories ?? [];
    const scopeOf = Object.fromEntries(hits.map((h) => [h.recordId, h.scopeMatch]));
    assert.equal(hits.length, 5, `every record must come back — got ${hits.map((h) => h.recordId).join(", ")}`);
    assert.equal(scopeOf["rec-now"], "session");
    assert.equal(scopeOf["rec-chat"], "workspace");
    assert.equal(scopeOf["rec-ingested"], "workspace", "the repo's own ingested file is here, not elsewhere");
    assert.equal(scopeOf["rec-legacy"], "untagged");
    assert.equal(scopeOf["rec-elsewhere"], "other-workspace");

    const order = hits.map((h) => h.scopeMatch);
    assert.equal(order[0], "session", "this session leads");
    assert.equal(order.at(-1), "other-workspace", "another repository is last, not gone");

    // The rendered context says which line is foreign, and only that one.
    const lines = (result.prependContext ?? "").split("\n");
    assert.match(lines.find((l) => l.includes("rec-elsewhere")) ?? "", /\(another workspace\)/);
    assert.doesNotMatch(lines.find((l) => l.includes("rec-ingested")) ?? "", /another workspace/);
  } finally {
    await cleanup();
  }
});

test("without a caller scope the real recall is unchanged — no labels, no provenance", async () => {
  const { engine, cleanup } = await createTestEngine();
  try {
    const store = (engine as unknown as { store: { upsertCognitive(r: unknown): Promise<unknown> } }).store;
    await store.upsertCognitive(record("rec-a", FOLDER));
    await store.upsertCognitive(record("rec-b", ELSEWHERE));
    const result = await engine.recall({ userId: "u1", sessionKey: "sk-now", query: "widget ledger reconciles invoices" });
    const hits = result.recalledCognitiveMemories ?? [];
    assert.ok(hits.length > 0, "otherwise the checks below prove nothing");
    for (const hit of hits) {
      assert.equal(hit.scopeMatch, undefined);
      assert.equal(hit.workspaceTag, undefined);
    }
    assert.doesNotMatch(result.prependContext ?? "", /another workspace/);
  } finally {
    await cleanup();
  }
});
