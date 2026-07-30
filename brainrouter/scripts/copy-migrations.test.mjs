import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { shouldCopyMigrationPath } from "./copy-migrations.mjs";

const root = mkdtempSync(join(tmpdir(), "brainrouter-release.0.4.17-"));
const migrations = join(root, "memory", "store", "postgres", "migrations");
const sql = join(migrations, "001_init.sql");
const ignored = join(migrations, "README.md");

mkdirSync(migrations, { recursive: true });
writeFileSync(sql, "SELECT 1;\n");
writeFileSync(ignored, "not a migration\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("migration copy accepts directories whose ancestor path contains dots", () => {
  assert.equal(shouldCopyMigrationPath(root), true);
  assert.equal(shouldCopyMigrationPath(migrations), true);
  assert.equal(shouldCopyMigrationPath(sql), true);
  assert.equal(shouldCopyMigrationPath(ignored), false);
});
