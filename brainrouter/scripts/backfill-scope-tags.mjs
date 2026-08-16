#!/usr/bin/env node
/**
 * ADR-017 D3 — one-off, idempotent backfill of scope columns on rows captured
 * before org_id / workspace_tag were stamped at capture time.
 *
 *   DATABASE_URL=postgres://… node brainrouter/scripts/backfill-scope-tags.mjs
 *
 * Safe to re-run: every write only touches NULL columns (see backfillScopeTags).
 * project_tag is intentionally not backfilled — the ADR forbids guessing a
 * Project for a historical row with no stored marker.
 */
import pg from "pg";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { backfillScopeTags } from "../dist/memory/store/postgres/backfillScopeTags.js";

const url = process.env.DATABASE_URL || process.env.BRAINROUTER_DATABASE_URL;
if (!url) {
  console.error("[backfill-scope-tags] Set DATABASE_URL (or BRAINROUTER_DATABASE_URL) to the target Postgres.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
const exec = {
  rows: async (text, params) => (await pool.query(text, params)).rows,
  run: async (text, params) => (await pool.query(text, params)).rowCount ?? 0,
};

try {
  const summary = await backfillScopeTags(exec, {
    hashWorkspacePath: workspaceTagFromPath,
    log: (message) => console.log("[backfill-scope-tags]", message),
  });
  console.log("[backfill-scope-tags] done:", JSON.stringify(summary, null, 2));
} catch (err) {
  console.error("[backfill-scope-tags] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
