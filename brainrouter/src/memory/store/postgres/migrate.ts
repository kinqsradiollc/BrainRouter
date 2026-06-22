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
 * Apply any migrations not yet recorded in `schema_migrations`, each in its own
 * transaction. Returns the ids applied this run. Idempotent. Requires a live
 * pool — never runs in unit tests.
 */
export async function applyMigrations(pool: Pool, migrations: Migration[]): Promise<string[]> {
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
}
