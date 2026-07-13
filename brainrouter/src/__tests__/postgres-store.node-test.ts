/**
 * ADR-007 Phase 2 (step 2) — PostgresMemoryStore parity test.
 *
 * Spins up a UNIQUE database in the docker Postgres (`CREATE DATABASE
 * br_test_<rand>` via an admin connection), constructs the store against it,
 * runs `init()` (migrations 001+002) + `initVec(8)`, and round-trips the core
 * memory path end-to-end:
 *   upsertCognitive → getMemoryById → searchCognitiveFts
 *   → upsertCognitiveVec + searchCognitiveVec
 *   → upsertSensory / getRecentSensoryMessages
 *   → enqueueMemoryJob / claimNextMemoryJob / completeMemoryJob
 *   → registerActiveSession / listActiveSessions
 *   → insertEvidence / getEvidenceByRecord
 *   → tree + blackboard + source round-trip
 *
 * Skips cleanly (returns early) when the docker Postgres is unreachable, so it
 * never hard-fails offline — but it MUST pass when pg is up. Runs under
 * `node --test` (the test:integration harness).
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";
import type { CognitiveRecord, SensoryRecord, MemoryEvidence } from "@kinqs/brainrouter-types";

const { Client } = pg;

// Admin connection used to create/drop the scratch database. Honors the standard
// env knobs (so CI can point elsewhere); defaults to the docker creds.
const ADMIN_URL =
  process.env.BRAINROUTER_TEST_PG_ADMIN_URL ??
  process.env.BRAINROUTER_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

const DB_NAME = `br_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function dbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** True when we could reach the admin pg and create the scratch DB. */
async function createScratchDb(): Promise<boolean> {
  const admin = new Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    return false; // pg unreachable → caller skips
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
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  } catch {
    /* best-effort cleanup */
  } finally {
    await admin.end().catch(() => undefined);
  }
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function cog(overrides: Partial<CognitiveRecord> & { id: string; content: string }): CognitiveRecord {
  const now = iso();
  return {
    userId: "u1",
    sessionKey: "sess-1",
    sessionId: "sid-1",
    type: "episodic",
    priority: 50,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    invalidAt: null,
    timestampStr: now,
    timestampStart: "",
    timestampEnd: "",
    createdTime: now,
    updatedTime: now,
    metadata: {},
    confidence: 0.65,
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
    workspaceTag: null,
    projectTag: null,
    ...overrides,
  };
}

function vec8(seed: number): Float32Array {
  // Deterministic unit-ish 8-d vector; distinct seeds → distinct directions.
  const v = new Float32Array(8);
  for (let i = 0; i < 8; i++) v[i] = Math.sin(seed * (i + 1) * 0.7) + 0.01 * (i + 1);
  return v;
}

test("PostgresMemoryStore: core round-trip against a fresh pgvector database", async (t) => {
  const ready = await createScratchDb();
  if (!ready) {
    t.skip("Postgres unreachable — skipping (set BRAINROUTER_TEST_PG_ADMIN_URL to run)");
    return;
  }

  const store = new PostgresMemoryStore(dbUrl(ADMIN_URL, DB_NAME));
  t.after(async () => {
    await store.close().catch(() => undefined);
    await dropScratchDb();
  });

  await store.init();
  await store.initVec(8);

  // Pentest targets are org/user scoped and therefore exercise the tenancy FKs.
  await store.createUser('u1', 'br_test_u1', 'Pentest owner');
  await store.createOrganization({ orgId: 'org-pentest', name: 'Pentest Org', slug: 'pentest-org', plan: 'team' });
  await store.addOrgMember('org-pentest', 'u1', 'owner');
  const target = await store.createPentestTarget('org-pentest', 'u1', { kind: 'domain', value: 'https://Example.test/path', authorized: true });
  assert.equal(target.normalizedValue, 'https://example.test');
  assert.equal((await store.listPentestTargets('org-pentest')).length, 1);
  assert.equal((await store.getPentestTarget(target.id))?.orgId, 'org-pentest');

  // version() works (sqlite_version → version()).
  const version = await store.getSqliteVersion();
  assert.match(version, /PostgreSQL/i, "getSqliteVersion returns the pg version banner");

  // ── cognitive upsert → getMemoryById ──
  const r1 = cog({ id: "rec-1", content: "the recall pipeline reranks keyword and vector candidates", filePaths: ["src/memory/recall.ts"] });
  await store.upsertCognitive(r1);
  const fetched = await store.getMemoryById("u1", "rec-1");
  assert.ok(fetched, "getMemoryById returns the upserted record");
  assert.equal(fetched!.content, r1.content);
  assert.equal(fetched!.type, "episodic");
  assert.deepEqual(fetched!.filePaths, ["src/memory/recall.ts"]);

  // tenant isolation: another user can't read it.
  assert.equal(await store.getMemoryById("other", "rec-1"), null, "record is user-scoped");

  // filepath index populated by the upsert.
  const byPath = await store.getMemoriesByFilePath("u1", "src/memory/recall.ts", 10);
  assert.equal(byPath.length, 1, "getMemoriesByFilePath finds the record via its file index");

  // ── FTS (generated tsvector + GIN) ──
  await store.upsertCognitive(cog({ id: "rec-2", content: "blackboard staging reconciles duplicate candidates before commit" }));
  const ftsHits = await store.searchCognitiveFts("u1", "reranks vector candidates", 10);
  assert.ok(ftsHits.length >= 1, "searchCognitiveFts matches on indexed terms");
  assert.ok(ftsHits.some((h) => h.record_id === "rec-1"), "FTS surfaces the relevant record");
  for (const h of ftsHits) assert.ok(h.score > 0 && h.score <= 1, "FTS score normalized into (0,1]");
  assert.deepEqual(await store.searchCognitiveFts("u1", "   ", 10), [], "empty/stopword query short-circuits to []");

  // ── vector (pgvector cosine) ──
  await store.upsertCognitiveVec("rec-1", vec8(1));
  await store.upsertCognitiveVec("rec-2", vec8(9));
  const vecHits = await store.searchCognitiveVec("u1", vec8(1), 5);
  assert.ok(vecHits.length >= 1, "searchCognitiveVec returns neighbours");
  assert.equal(vecHits[0].record_id, "rec-1", "nearest vector is the matching record");
  assert.ok(vecHits[0].score >= vecHits[vecHits.length - 1].score, "vector results ordered by descending similarity");

  // ── sensory stream ──
  const s1: SensoryRecord = { id: "sen-1", userId: "u1", sessionKey: "sess-1", sessionId: "sid-1", role: "user", messageText: "first turn", recordedAt: iso(-2000), timestamp: Date.now() - 2000, skillTag: "" };
  const s2: SensoryRecord = { id: "sen-2", userId: "u1", sessionKey: "sess-1", sessionId: "sid-1", role: "assistant", messageText: "second turn", recordedAt: iso(-1000), timestamp: Date.now() - 1000, skillTag: "" };
  await store.upsertSensory(s1);
  await store.upsertSensory(s2);
  const recent = await store.getRecentSensoryMessages("u1", "sess-1", 10, iso(-5000));
  assert.equal(recent.length, 2, "both sensory rows returned");
  assert.equal(recent[0].id, "sen-1", "sensory messages chronological (oldest first)");
  assert.equal(recent[1].id, "sen-2");
  assert.equal(typeof recent[0].timestamp, "number", "bigint timestamp coerced to a number");
  assert.equal(await store.getUnextractedSensoryCount("u1", "sess-1"), 2);
  await store.markSensoryExtracted("u1", "sess-1", ["sen-1"]);
  assert.equal(await store.getUnextractedSensoryCount("u1", "sess-1"), 1, "marking one extracted decrements the unextracted count");

  // ── memory jobs (atomic claim) ──
  const job = await store.enqueueMemoryJob({ kind: "cognitive_extract", input: { sessionKey: "sess-1" } });
  assert.equal(job.status, "pending");
  const claimed = await store.claimNextMemoryJob();
  assert.ok(claimed, "claimNextMemoryJob picks the pending job");
  assert.equal(claimed!.id, job.id);
  assert.equal(claimed!.status, "running");
  assert.equal(await store.claimNextMemoryJob(), null, "no second eligible job to claim");
  const done = await store.completeMemoryJob(job.id, { extracted: 3 });
  assert.equal(done!.status, "done", "completeMemoryJob transitions running → done");
  assert.deepEqual(done!.output, { extracted: 3 });

  // ── active sessions (federation) ──
  const reg = await store.registerActiveSession({
    sessionKey: "sk-1", userId: "u1", clientKind: "brainrouter-cli", workspaceRoot: "/repo",
    startedAt: iso(-1000), lastHeartbeatAt: iso(), metadata: { pid: 42 },
  });
  assert.equal(reg.sessionKey, "sk-1");
  const sessions = await store.listActiveSessions({ userId: "u1" });
  assert.equal(sessions.length, 1, "listActiveSessions returns the live session");
  assert.equal(sessions[0].clientKind, "brainrouter-cli");
  assert.equal(await store.heartbeatActiveSession("u1", "sk-1", iso()), true, "heartbeat updates an existing session");
  assert.equal(await store.heartbeatActiveSession("u1", "nope", iso()), false, "heartbeat on a missing session is false");

  // ── evidence ──
  const ev: MemoryEvidence = { id: "ev-1", userId: "u1", recordId: "rec-1", kind: "file", ref: "src/memory/recall.ts", excerpt: "rerank", observedAt: iso(), metadata: { line: 10 } };
  await store.insertEvidence(ev);
  const evList = await store.getEvidenceByRecord("u1", "rec-1");
  assert.equal(evList.length, 1, "getEvidenceByRecord returns the inserted evidence");
  assert.equal(evList[0].ref, "src/memory/recall.ts");
  assert.deepEqual(evList[0].metadata, { line: 10 });

  // ── source documents + chunks round-trip ──
  const doc = await store.createSourceDocument({ userId: "u1", workspaceTag: null, kind: "file", uri: "src/foo.ts", hash: "deadbeef", title: "foo.ts", metadata: {} });
  const chunks = await store.addSourceChunks(doc.id, [
    { content: "export function alpha() { return beta(); }", tokenCount: 10, filePath: "src/foo.ts", symbol: "alpha", startLine: 1, endLine: 1 },
    { content: "export function beta() { return 1; }", tokenCount: 8, filePath: "src/foo.ts", symbol: "beta", startLine: 3, endLine: 3 },
  ]);
  assert.equal(chunks.length, 2, "addSourceChunks returns both chunks");
  const reread = await store.getSourceChunksByDocument(doc.id);
  assert.equal(reread.length, 2);
  assert.equal(reread[0].ordinal, 0, "chunk ordinals start at 0");
  // provenance link + read-back.
  await store.linkRecordSources("u1", "rec-1", [chunks[0].id]);
  const linked = await store.getRecordSourceChunks("u1", "rec-1");
  assert.equal(linked.length, 1, "getRecordSourceChunks returns the linked chunk");
  assert.equal(linked[0].id, chunks[0].id);
  // chunk FTS over the generated tsvector.
  const chunkHits = await store.searchSourceChunksFts("u1", "beta", 10);
  assert.ok(chunkHits.some((c) => c.symbol === "beta"), "searchSourceChunksFts matches a chunk by symbol/content");
  // intra-file call edge: alpha → beta was recorded.
  const callees = await store.getCodeEdgeNeighbors("u1", chunks[0].id, "callees");
  assert.ok(callees.some((c) => c.id === chunks[1].id), "code edge: alpha calls beta");

  // ── blackboard round-trip ──
  const staged = await store.stageBlackboardItems("u1", [
    { sourceChunkId: chunks[0].id, candidate: { content: "alpha calls beta", type: "episodic", priority: 60 }, score: 0.5 },
  ]);
  assert.equal(staged.length, 1, "stageBlackboardItems stages a candidate");
  assert.equal(staged[0].status, "pending");
  const pending = await store.getBlackboardItems("u1", "pending");
  assert.equal(pending.length, 1);
  await store.updateBlackboardItem(staged[0].id, { status: "reconciled", score: 0.9 });
  const after = await store.getBlackboardItem(staged[0].id);
  assert.equal(after!.status, "reconciled", "updateBlackboardItem patches status");
  assert.equal(after!.score, 0.9);

  // ── tree round-trip ──
  const leaf = await store.appendTreeNode("u1", { kind: "source", level: 0, summaryMd: "leaf summary", sourceChunkIds: [chunks[0].id], heatScore: 1 });
  assert.ok(leaf.id.startsWith("tree_"), "appendTreeNode returns a tree node");
  const roots = await store.getTreeRoots("u1");
  assert.equal(roots.length, 1, "the leaf is a root until parented");
  const parent = await store.appendTreeNode("u1", { kind: "global", level: 1, summaryMd: "parent" });
  await store.setTreeParent([leaf.id], parent.id);
  const children = await store.getTreeChildren(parent.id);
  assert.equal(children.length, 1, "setTreeParent re-parents the leaf under the new parent");
  assert.equal(children[0].id, leaf.id);
  const found = await store.getTreeNodeIdByChunkId("u1", chunks[0].id);
  assert.equal(found, leaf.id, "getTreeNodeIdByChunkId resolves the leaf covering the chunk");

  // ── compression cache (CCR) quick round-trip ──
  const content = JSON.stringify([{ a: 1 }, { b: 2 }]);
  const meta = await store.storeCompressionEntry({ userId: "u1", originalContent: content, compressedContent: "small", originalTokens: 100, compressedTokens: 10 });
  const retrieved = await store.retrieveCompressionEntry("u1", meta.hash);
  assert.ok(retrieved, "retrieveCompressionEntry returns the stored entry");
  assert.equal(retrieved!.kind, "full");
  assert.equal(retrieved!.originalContent, content);

  // ── stats sanity ──
  const stats = await store.getMemoryStats("u1");
  assert.equal(stats.total, 2, "two cognitive records counted");
  assert.equal(stats.sensoryTotal, 2, "two sensory rows counted");
  assert.equal(stats.sensoryUnextracted, 1, "one sensory row still unextracted");
  assert.ok(stats.byType.episodic >= 2, "byType rollup includes episodic");
});
