import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { applyMigrations, loadMigrations } from "./memory/store/postgres/migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("./memory/store/postgres/migrations", import.meta.url));

export function postgresDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.BRAINROUTER_DATABASE_URL?.trim();
  if (!value) throw new Error("BRAINROUTER_DATABASE_URL is required for migrations");
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("protocol");
  } catch {
    throw new Error("BRAINROUTER_DATABASE_URL must be a valid PostgreSQL URL");
  }
  return value;
}

export async function runPostgresMigrations(connectionString = postgresDatabaseUrl()): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    return await applyMigrations(pool, loadMigrations(MIGRATIONS_DIR));
  } finally {
    await pool.end();
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedAs === import.meta.url) {
  runPostgresMigrations().then((applied) => {
    console.info(`[migrator] schema ready; applied ${applied.length} migration(s)`);
  }).catch((error) => {
    console.error("[migrator] migration failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}

