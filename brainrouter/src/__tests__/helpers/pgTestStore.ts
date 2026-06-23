/**
 * ADR-007 Phase 2 (step 3) — shared Postgres test-store helper.
 *
 * SQLite is gone; the brain test suite runs entirely against the docker
 * pgvector. Each call to `createTestStore()` provisions a UNIQUE scratch
 * DATABASE in the configured Postgres (admin-connect + `CREATE DATABASE
 * br_test_<ts>_<rand>`), constructs a `PostgresMemoryStore` against it, runs
 * `init()` (migrations) + `initVec(8)` (a small test embedding dim), and hands
 * back a `cleanup()` that closes the pool and drops the scratch DB.
 *
 * `createTestEngine()` layers a `MemoryEngine` on top and awaits engine
 * readiness (`engine.ready`) so the seed-admin + vec init have completed before
 * the test touches the store.
 *
 * Connection knobs (mirrors postgres-store.node-test.ts):
 *   BRAINROUTER_TEST_PG_ADMIN_URL → BRAINROUTER_DATABASE_URL → DATABASE_URL →
 *   postgres://postgres:postgres@localhost:5432/postgres
 */

import pg from "pg";
import { PostgresMemoryStore } from "../../memory/store/postgres/PostgresMemoryStore.js";
import { MemoryEngine } from "../../memory/engine.js";

const { Client } = pg;

/** Small embedding dimension used across the suite's scratch DBs. */
export const TEST_VEC_DIM = 8;

/**
 * Admin connection string used to create/drop scratch databases. Honors the
 * standard env knobs (so CI can point elsewhere); defaults to the docker creds.
 */
export const ADMIN_URL =
  process.env.BRAINROUTER_TEST_PG_ADMIN_URL ??
  process.env.BRAINROUTER_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/postgres";

/** Build a connection string for `dbName` against the admin host/credentials. */
function dbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function createScratchDb(adminUrl: string, dbName: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function dropScratchDb(adminUrl: string, dbName: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    /* best-effort cleanup */
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export interface TestStoreHandle {
  store: PostgresMemoryStore;
  /** Connection string for the scratch database (handy for raw `pg.Client` probes). */
  url: string;
  cleanup: () => Promise<void>;
}

/** Options forwarded to `PostgresMemoryStore` (e.g. CCR clock/ttl injection in tests). */
export interface CreateTestStoreOptions {
  compressionStore?: { ttlSeconds?: number; maxEntries?: number; now?: () => number };
  /** Override the embedding dim used for `initVec` (default 8). Pass 0 to skip vec init. */
  vecDim?: number;
}

/**
 * Provision a fresh, isolated Postgres database, return an initialized
 * `PostgresMemoryStore` against it plus a `cleanup()` that closes the pool and
 * drops the database. `initVec(8)` is run so a small test embedding dim is ready.
 */
export async function createTestStore(opts?: CreateTestStoreOptions): Promise<TestStoreHandle> {
  const dbName = `br_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await createScratchDb(ADMIN_URL, dbName);
  const url = dbUrl(ADMIN_URL, dbName);
  const store = new PostgresMemoryStore(
    url,
    opts?.compressionStore ? { compressionStore: opts.compressionStore } : undefined,
  );
  const vecDim = opts?.vecDim ?? TEST_VEC_DIM;
  try {
    await store.init();
    if (vecDim > 0) await store.initVec(vecDim);
  } catch (err) {
    await store.close().catch(() => undefined);
    await dropScratchDb(ADMIN_URL, dbName);
    throw err;
  }
  return {
    store,
    url,
    cleanup: async () => {
      await store.close().catch(() => undefined);
      await dropScratchDb(ADMIN_URL, dbName);
    },
  };
}

export interface TestEngineHandle {
  engine: MemoryEngine;
  store: PostgresMemoryStore;
  url: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a `MemoryEngine` over a fresh scratch Postgres store and await engine
 * readiness (`engine.ready`) before returning, so seed-admin + vec init have
 * completed. The job runner is disabled by default (tests drive ticks
 * manually); pass `{ jobRunner: true }` to leave it on.
 */
export async function createTestEngine(opts?: { jobRunner?: boolean }): Promise<TestEngineHandle> {
  // Tests overwhelmingly expect a quiet background (no async job runner racing
  // their assertions); default it off unless the test opts in.
  const prevJobRunner = process.env.BRAINROUTER_JOB_RUNNER;
  if (!opts?.jobRunner) process.env.BRAINROUTER_JOB_RUNNER = "off";

  const handle = await createTestStore();
  let engine: MemoryEngine;
  try {
    engine = new MemoryEngine(handle.store);
    await engine.ready;
  } catch (err) {
    if (!opts?.jobRunner) {
      if (prevJobRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
      else process.env.BRAINROUTER_JOB_RUNNER = prevJobRunner;
    }
    await handle.cleanup();
    throw err;
  }

  if (!opts?.jobRunner) {
    if (prevJobRunner === undefined) delete process.env.BRAINROUTER_JOB_RUNNER;
    else process.env.BRAINROUTER_JOB_RUNNER = prevJobRunner;
  }

  return {
    engine,
    store: handle.store,
    url: handle.url,
    cleanup: handle.cleanup,
  };
}
