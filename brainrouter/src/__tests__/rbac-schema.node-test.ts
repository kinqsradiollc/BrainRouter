/**
 * MEM-14 — every new 0.4.3 table carries user_id + workspace_tag.
 *
 * This is a DB-free static check: SQLite is gone, so rather than booting a
 * store we read the Postgres schema migration directly and assert each table's
 * CREATE TABLE block declares both `user_id` and `workspace_tag` columns. That
 * keeps the RBAC scoping invariant enforced at the schema source of truth.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCHEMA_PATH = join(
  __dirname,
  "..",
  "memory",
  "store",
  "postgres",
  "migrations",
  "002_schema.sql",
);

const NEW_TABLES = [
  "source_documents",
  "source_chunks",
  "cognitive_source_links",
  "memory_blackboard_items",
  "memory_tree_nodes",
  "vault_exports",
];

/**
 * Extract the body of a `CREATE TABLE [IF NOT EXISTS] <name> ( ... );` block
 * from the schema SQL. Returns the text between the outermost parens.
 */
function createTableBody(sql: string, table: string): string {
  const re = new RegExp(
    `CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${table}\\s*\\(`,
    "i",
  );
  const m = re.exec(sql);
  assert.ok(m, `schema must declare CREATE TABLE ${table}`);
  const start = m.index + m[0].length;
  // Walk to the matching close paren (handles nested parens in column defs).
  let depth = 1;
  let i = start;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
  }
  return sql.slice(start, i - 1);
}

test("MEM-14 every new 0.4.3 table carries user_id + workspace_tag", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  for (const t of NEW_TABLES) {
    const body = createTableBody(schema, t);
    assert.match(body, /\buser_id\b/, `${t} should carry user_id`);
    assert.match(body, /\bworkspace_tag\b/, `${t} should carry workspace_tag`);
  }
});
