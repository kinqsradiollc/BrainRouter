import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

const NEW_TABLES = [
  "source_documents",
  "source_chunks",
  "cognitive_source_links",
  "memory_blackboard_items",
  "memory_tree_nodes",
  "vault_exports",
];

test("MEM-14 every new 0.4.3 table carries user_id + workspace_tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-rbac-"));
  const dbPath = join(dir, "m.db");
  try {
    const store = new SqliteMemoryStore(dbPath);
    store.init();
    const raw = new DatabaseSync(dbPath);
    try {
      for (const t of NEW_TABLES) {
        const cols = (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(cols.includes("user_id"), `${t} should carry user_id`);
        assert.ok(cols.includes("workspace_tag"), `${t} should carry workspace_tag`);
      }
    } finally {
      raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MEM-14 source_chunks denormalize the parent doc's scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-rbac2-"));
  const dbPath = join(dir, "m.db");
  try {
    const store = new SqliteMemoryStore(dbPath);
    store.init();
    const doc = store.createSourceDocument({ userId: "u1", workspaceTag: "ws16", kind: "transcript", uri: null, hash: "h", title: "t" });
    store.addSourceChunks(doc.id, [{ content: "x", tokenCount: 1 }]);
    const raw = new DatabaseSync(dbPath);
    try {
      const row = raw.prepare("SELECT user_id, workspace_tag FROM source_chunks LIMIT 1").get() as { user_id: string; workspace_tag: string };
      assert.equal(row.user_id, "u1");
      assert.equal(row.workspace_tag, "ws16");
    } finally {
      raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
