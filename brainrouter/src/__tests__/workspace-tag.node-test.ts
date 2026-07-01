/**
 * Federation Stage 1 (FED-S1-T3) — workspaceTag round-trips and the
 * NULL-tolerant recall filter.
 *
 * Runs under `node --test` against the docker pgvector (see pgTestStore.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { createTestStore } from "./helpers/pgTestStore.js";

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

test("upsertCognitive round-trips workspaceTag", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const tagAlpha = workspaceTagFromPath("/repos/alpha")!;
    await store.upsertCognitive(makeRecord({ id: "rec-alpha", workspaceTag: tagAlpha }) as any);
    const fetched = await store.getMemoryById("u1", "rec-alpha");
    assert.equal(fetched?.workspaceTag, tagAlpha);
  } finally {
    await cleanup();
  }
});

test("getWorkspaceTagsByRecordIds returns a Map covering every requested id, NULL when missing or untagged", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const tagAlpha = workspaceTagFromPath("/repos/alpha")!;
    await store.upsertCognitive(makeRecord({ id: "rec-tagged", workspaceTag: tagAlpha }) as any);
    await store.upsertCognitive(makeRecord({ id: "rec-untagged" }) as any); // workspaceTag undefined → stored as NULL
    const tags = await store.getWorkspaceTagsByRecordIds("u1", ["rec-tagged", "rec-untagged", "rec-missing"]);
    assert.equal(tags.get("rec-tagged"), tagAlpha);
    assert.equal(tags.get("rec-untagged"), null);
    assert.equal(tags.get("rec-missing"), null);
    assert.equal(tags.size, 3);
  } finally {
    await cleanup();
  }
});

test("init() tolerates a second call (idempotent migrations, no duplicate-table crash on re-boot)", async () => {
  // Re-running init() must be a no-op (schema_migrations gates applied
  // migrations), not re-throw — the Postgres analog of SQLite's re-open
  // ALTER-TABLE tolerance. Data written before the re-init survives.
  const { store, cleanup } = await createTestStore();
  try {
    await store.upsertCognitive(makeRecord({ id: "rec-first", workspaceTag: "deadbeefcafebabe" }) as any);
    // Second init() re-applies nothing; must not explode.
    await store.init();
    const fetched = await store.getMemoryById("u1", "rec-first");
    assert.equal(fetched?.workspaceTag, "deadbeefcafebabe");
  } finally {
    await cleanup();
  }
});
