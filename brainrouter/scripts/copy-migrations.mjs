/**
 * Copy SQL migration files into dist after `tsc` (which only emits .js). The
 * Postgres store loads `*.sql` from its migrations dir at runtime, so they must
 * sit next to the compiled output. Portable (no shell-specific cp).
 */
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rel = "memory/store/postgres/migrations";
const src = join(root, "src", rel);
const dest = join(root, "dist", rel);

export function shouldCopyMigrationPath(sourcePath) {
  return statSync(sourcePath).isDirectory() || sourcePath.endsWith(".sql");
}

if (existsSync(src)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: shouldCopyMigrationPath,
  });
  console.log(`[copy-migrations] ${src} -> ${dest}`);
} else {
  console.log(`[copy-migrations] no migrations at ${src} (skipped)`);
}
