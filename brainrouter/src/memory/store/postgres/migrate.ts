/**
 * Postgres migration runner (ADR-007 Phase 1).
 *
 * `orderMigrations` is pure (unit-tested, no DB). `applyMigrations` runs the
 * not-yet-applied migrations, each in its own transaction, recorded in
 * `schema_migrations` — idempotent, and only invoked when a live pool exists
 * (callers gate on `isPostgresConfigured`). The `pg` import is type-only so this
 * module loads with no runtime dependency.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

export interface Migration {
  id: string;
  sql: string;
}

/** Order migration filenames by leading numeric prefix, then name; drop non-.sql. */
export function orderMigrations(files: string[]): string[] {
  const num = (f: string): number => {
    const m = f.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  return [...files].filter((f) => f.endsWith(".sql")).sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

/** Load ordered migrations from a directory of `NNN_name.sql` files. */
export function loadMigrations(dir: string): Migration[] {
  return orderMigrations(readdirSync(dir)).map((f) => ({
    id: f.replace(/\.sql$/, ""),
    sql: readFileSync(path.join(dir, f), "utf8"),
  }));
}

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

/**
 * Fixed advisory-lock key that serializes schema DDL across processes. Arbitrary
 * but stable 64-bit constant; every process that runs migrations or `initVec`
 * takes THIS lock, so only one mutates the schema at a time.
 */
const SCHEMA_LOCK_KEY = 4927300191;

/**
 * Run `fn` while holding a Postgres SESSION advisory lock, so concurrent
 * processes SERIALIZE schema DDL instead of racing. Without it, two processes
 * booting at once (multiple replicas, a migrator overlapping a booting brain, or
 * a `tsx watch` restart overlapping its predecessor) both pass the same
 * `CREATE EXTENSION IF NOT EXISTS vector` / `CREATE TABLE IF NOT EXISTS`
 * existence check and both run the DDL — the loser dies with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`
 * (from `CREATE EXTENSION vector` registering the `vector` type) or the matching
 * `pg_class_relname_nsp_index` for a table. The lock is held on a dedicated
 * client for the whole run and always released, even on error.
 */
export async function withSchemaLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(${SCHEMA_LOCK_KEY})`);
    return await fn();
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(${SCHEMA_LOCK_KEY})`).catch(() => {});
    lock.release();
  }
}

/**
 * Apply any migrations not yet recorded in `schema_migrations`, each in its own
 * transaction. Returns the ids applied this run. Idempotent, and safe to call
 * from multiple processes concurrently — the whole run holds a schema advisory
 * lock (see `withSchemaLock`). Requires a live pool — never runs in unit tests.
 */
export async function applyMigrations(pool: Pool, migrations: Migration[]): Promise<string[]> {
  return withSchemaLock(pool, async () => {
    await pool.query(TRACKING_TABLE);
    const res = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
    const done = new Set(res.rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        applied.push(m.id);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return applied;
  });
}
