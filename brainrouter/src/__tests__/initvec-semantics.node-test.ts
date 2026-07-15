/**
 * initVec dimension semantics — regression guard for the boot-time vector wipe.
 *
 * Two independent bugs used to conspire to DROP cognitive_vec (and force a full
 * re-embed) on every boot:
 *   1. the column-dimension read used `atttypmod - 4`, but pgvector stores the
 *      dimension verbatim (vector(768) → atttypmod 768, not 772), so it read 764
 *      and never matched the real width; and
 *   2. boot passed a hand-set env dimension that could disagree with the stored
 *      width.
 *
 * The fix: read atttypmod directly, and make BOOT non-destructive
 * (`allowRebuild:false`) so it adopts the running store's width instead of a
 * guess. Only the WRITE path (a CONFIRMED embedding length) may rebuild on a
 * genuine dimension change. This test pins that contract against a real pgvector
 * DB (scratch database, dropped on teardown). Skips cleanly when pg is offline.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";

const { Client } = pg;

const ADMIN_URL =
  process.env.BRAINROUTER_TEST_PG_ADMIN_URL ??
  process.env.BRAINROUTER_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

const DB_NAME = `br_test_initvec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function dbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function createScratchDb(): Promise<boolean> {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    return false;
  }
  try {
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    return true;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function dropScratchDb(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function cog(id: string): CognitiveRecord {
  const now = iso();
  return {
    userId: "u1", sessionKey: "s", sessionId: "sid", type: "episodic", priority: 50,
    sceneName: "", skillTag: "", halfLifeDays: null, supersededBy: null, invalidAt: null,
    timestampStr: now, timestampStart: "", timestampEnd: "", createdTime: now, updatedTime: now,
    metadata: {}, confidence: 0.65, status: "active", sourceKind: "", verificationStatus: "",
    repoPaths: [], filePaths: [], commands: [], citationCount: 0, lastCitedAt: null,
    neverCitedCount: 0, archived: false, workspaceTag: null, projectTag: null,
    id, content: `content for ${id}`,
  };
}

function vec(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * (i + 1) * 0.7) + 0.01 * (i + 1);
  return v;
}

test("initVec: boot never drops (adopts stored width); write path rebuilds on a real change", async (t) => {
  if (!(await createScratchDb())) {
    t.skip("Postgres unreachable — skipping (set BRAINROUTER_TEST_PG_ADMIN_URL to run)");
    return;
  }
  const store = new PostgresMemoryStore(dbUrl(ADMIN_URL, DB_NAME));
  t.after(async () => {
    await store.close().catch(() => undefined);
    await dropScratchDb();
  });

  await store.init();
  await store.createUser("u1", "br_test_u1", "Owner");
  await store.upsertCognitive(cog("rec-1"));

  // Build the table at 8 and store a vector.
  await store.initVec(8);
  assert.equal(store.getVecDimensions(), 8);
  await store.upsertCognitiveVec("rec-1", vec(8, 1));
  assert.equal((await store.searchCognitiveVec("u1", vec(8, 1), 5)).length, 1, "vector stored");

  // BOOT with the SAME width → row preserved.
  await store.initVec(8, { allowRebuild: false });
  assert.equal(store.getVecDimensions(), 8);
  assert.equal((await store.searchCognitiveVec("u1", vec(8, 1), 5)).length, 1, "same-dim boot preserves the vector");

  // BOOT with a STALE, DIFFERING hint → must ADOPT the stored width (8), NOT drop.
  // This is the exact regression: a wrong boot dimension used to wipe the store.
  await store.initVec(4096, { allowRebuild: false });
  assert.equal(store.getVecDimensions(), 8, "stale boot hint is ignored; stored width adopted");
  assert.equal((await store.searchCognitiveVec("u1", vec(8, 1), 5)).length, 1, "stale-hint boot did NOT drop the vector");

  // WRITE PATH (allowRebuild defaults true) with a CONFIRMED new length → rebuild.
  await store.initVec(16);
  assert.equal(store.getVecDimensions(), 16, "confirmed dimension change rebuilds the table");
  assert.equal((await store.searchCognitiveVec("u1", vec(16, 1), 5)).length, 0, "table rebuilt empty at the new width");
  await store.upsertCognitiveVec("rec-1", vec(16, 1));
  assert.equal((await store.searchCognitiveVec("u1", vec(16, 1), 5)).length, 1, "new-width vectors round-trip");
});
