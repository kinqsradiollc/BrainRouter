import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { MemoryEngine } from "../memory/engine.js";

/**
 * 0.4.3 — provenance-safe transcript retention (memory_prune_sources).
 * Old transcripts are removed to bound growth, but never one whose chunks are
 * still cited by a live memory's provenance, and never a non-transcript source.
 */

function fresh(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-prune-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("prune: removes old unreferenced transcripts; keeps referenced / recent / non-transcript / other-user", () => {
  const { store, cleanup } = fresh("store");
  try {
    const OLD = "2020-01-01T00:00:00.000Z";
    const NEW = "2099-01-01T00:00:00.000Z";
    const cutoff = "2050-01-01T00:00:00.000Z";

    const oldUnref = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h-old-unref", title: "old", createdAt: OLD });
    store.addSourceChunks(oldUnref.id, [{ content: "old unreferenced turn", tokenCount: 3 }]);

    const oldRef = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h-old-ref", title: "old-ref", createdAt: OLD });
    const refChunks = store.addSourceChunks(oldRef.id, [{ content: "old referenced turn", tokenCount: 3 }]);
    store.linkRecordSources("u1", "recA", refChunks.map((c) => c.id));

    const recent = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h-recent", title: "recent", createdAt: NEW });
    store.addSourceChunks(recent.id, [{ content: "recent turn", tokenCount: 2 }]);

    const oldFile = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "a.ts", hash: "h-file", title: "a.ts", createdAt: OLD });
    store.addSourceChunks(oldFile.id, [{ content: "code", tokenCount: 1 }]);

    const otherUser = store.createSourceDocument({ userId: "u2", workspaceTag: null, kind: "transcript", uri: null, hash: "h-u2", title: "u2", createdAt: OLD });
    store.addSourceChunks(otherUser.id, [{ content: "u2 turn", tokenCount: 2 }]);

    const res = store.pruneTranscriptSources("u1", cutoff);
    assert.equal(res.prunedDocs, 1, "only the old unreferenced transcript is pruned");
    assert.equal(res.prunedChunks, 1);

    const remaining = store.getSourceDocuments("u1").map((d) => d.id);
    assert.ok(!remaining.includes(oldUnref.id), "old unreferenced transcript removed");
    assert.ok(remaining.includes(oldRef.id), "referenced transcript KEPT (provenance protected)");
    assert.ok(remaining.includes(recent.id), "recent transcript kept");
    assert.ok(remaining.includes(oldFile.id), "non-transcript source kept");
    // provenance for recA still resolves — its chunk survived the prune.
    assert.equal(store.getRecordSourceChunks("u1", "recA").length, 1, "live provenance intact");
    // cross-tenant: u2's old transcript untouched.
    assert.equal(store.getSourceDocuments("u2").length, 1, "other user not touched");
  } finally {
    cleanup();
  }
});

test("prune: a no-op when nothing qualifies", () => {
  const { store, cleanup } = fresh("noop");
  try {
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h", title: "t", createdAt: "2099-01-01T00:00:00.000Z" });
    store.addSourceChunks(doc.id, [{ content: "recent", tokenCount: 1 }]);
    assert.deepEqual(store.pruneTranscriptSources("u1", "2050-01-01T00:00:00.000Z"), { prunedDocs: 0, prunedChunks: 0 });
    assert.equal(store.getSourceDocuments("u1").length, 1);
  } finally {
    cleanup();
  }
});

test("engine.pruneTranscriptSources: days → cutoff + capability passthrough", () => {
  const { store, cleanup } = fresh("engine");
  try {
    const engine = new MemoryEngine(store);
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "transcript", uri: null, hash: "h1", title: "t", createdAt: sixtyDaysAgo });
    store.addSourceChunks(doc.id, [{ content: "old turn", tokenCount: 2 }]);
    // olderThanDays=30 → a 60-day-old transcript is pruned.
    const res = engine.pruneTranscriptSources("u1", 30);
    assert.equal(res.prunedDocs, 1);
    assert.equal(store.getSourceDocuments("u1").length, 0);
  } finally {
    cleanup();
  }
});
