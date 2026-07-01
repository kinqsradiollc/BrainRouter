/**
 * Postgres connection (ADR-007 Phase 1) — pooled connection from the server-env
 * config, plus the "is Postgres configured?" predicate the store selector will
 * use. Additive and inert: nothing wires this into the store yet (SQLite stays
 * the default); the PostgresMemoryStore adapter is Phase 2.
 *
 * `pg` is CommonJS — import the default and destructure to stay correct under
 * NodeNext ESM.
 */
import pg from "pg";
import type { Pool, PoolConfig } from "pg";

const { Pool: PgPool } = pg;

/**
 * The brain's Postgres connection string from the environment, or undefined.
 * Server-env config model (ADR-004): the deployable brain reads
 * `BRAINROUTER_DATABASE_URL` (preferred) or the conventional `DATABASE_URL`.
 */
export function pgUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = (env.BRAINROUTER_DATABASE_URL ?? env.DATABASE_URL ?? "").trim();
  return url.length > 0 ? url : undefined;
}

/** True when a Postgres backend is configured (else the brain uses SQLite). */
export function isPostgresConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return pgUrlFromEnv(env) !== undefined;
}

/** Create a lazy pooled Postgres connection from a connection string. */
export function createPgPool(connectionString: string, extra: PoolConfig = {}): Pool {
  return new PgPool({ connectionString, ...extra });
}
