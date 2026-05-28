/**
 * Federation Stage 1 (FED-S1-T3) — workspaceTag round-trips and the
 * NULL-tolerant recall filter.
 *
 * Why node:test (see sqlite-wal.node-test.ts for the long version): the
 * brain's vitest 1.6 cannot resolve `node:sqlite`. Tests that need a
 * real DatabaseSync via SqliteMemoryStore live in `*.node-test.ts` and
 * run via `npm run test:integration`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-tag-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeRecord(overrides: Partial<Record<string, unknown>> & { id: string }): any {
  return {
    userId: "u1",
    sessionKey: "sk-1",
    sessionId: "sid-1",
    content: "fact",
    type: "codebase_fact",
    priority: 50,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    invalidAt: null,
    timestampStr: "2026-05-28",
    timestampStart: "2026-05-28T00:00:00Z",
    timestampEnd: "2026-05-28T00:00:00Z",
    createdTime: "2026-05-28T00:00:00Z",
    updatedTime: "2026-05-28T00:00:00Z",
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
    ...overrides,
  };
}

test("workspaceTagFromPath produces a stable 16-char hex hash", () => {
  const tagA = workspaceTagFromPath("/Users/anh/projects/alpha");
  assert.match(tagA ?? "", /^[0-9a-f]{16}$/);
  assert.equal(tagA, workspaceTagFromPath("/Users/anh/projects/alpha"));
  assert.notEqual(tagA, workspaceTagFromPath("/Users/anh/projects/beta"));
});

test("workspaceTagFromPath returns null for empty input (so callers don't tag a synthetic constant)", () => {
  assert.equal(workspaceTagFromPath(""), null);
  assert.equal(workspaceTagFromPath(null), null);
  assert.equal(workspaceTagFromPath(undefined), null);
});

test("upsertCognitive round-trips workspaceTag", () => {
  const { store, cleanup } = freshDb("upsert");
  try {
    const tagAlpha = workspaceTagFromPath("/repos/alpha")!;
    store.upsertCognitive(makeRecord({ id: "rec-alpha", workspaceTag: tagAlpha }) as any);
    const fetched = store.getMemoryById("u1", "rec-alpha");
    assert.equal(fetched?.workspaceTag, tagAlpha);
  } finally {
    cleanup();
  }
});

test("getWorkspaceTagsByRecordIds returns a Map covering every requested id, NULL when missing or untagged", () => {
  const { store, cleanup } = freshDb("lookup");
  try {
    const tagAlpha = workspaceTagFromPath("/repos/alpha")!;
    store.upsertCognitive(makeRecord({ id: "rec-tagged", workspaceTag: tagAlpha }) as any);
    store.upsertCognitive(makeRecord({ id: "rec-untagged" }) as any); // workspaceTag undefined → stored as NULL
    const tags = store.getWorkspaceTagsByRecordIds("u1", ["rec-tagged", "rec-untagged", "rec-missing"]);
    assert.equal(tags.get("rec-tagged"), tagAlpha);
    assert.equal(tags.get("rec-untagged"), null);
    assert.equal(tags.get("rec-missing"), null);
    assert.equal(tags.size, 3);
  } finally {
    cleanup();
  }
});

test("ALTER TABLE migration tolerates a second call (no duplicate-column crash on re-boot)", () => {
  // Open + close + reopen the same DB. Second `init()` re-runs the
  // ALTER TABLE; the SQLite duplicate-column error must be swallowed
  // (it indicates the migration already landed) rather than surfaced.
  const dir = mkdtempSync(join(tmpdir(), "brainrouter-tag-reopen-"));
  const dbPath = join(dir, "memory.db");
  try {
    const a = new SqliteMemoryStore(dbPath);
    a.init();
    a.upsertCognitive(makeRecord({ id: "rec-first", workspaceTag: "deadbeefcafebabe" }) as any);
    // Re-open the same file. If the migration code re-throws on
    // "duplicate column name", this constructor call would explode.
    const b = new SqliteMemoryStore(dbPath);
    b.init();
    const fetched = b.getMemoryById("u1", "rec-first");
    assert.equal(fetched?.workspaceTag, "deadbeefcafebabe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
