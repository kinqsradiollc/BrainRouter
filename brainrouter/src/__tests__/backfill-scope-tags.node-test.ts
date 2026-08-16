import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { createTestStore } from "./helpers/pgTestStore.js";
import { backfillScopeTags, type BackfillExec } from "../memory/store/postgres/backfillScopeTags.js";

/** Minimal Executor adapter over a raw pg Pool — what the ops script also uses. */
function poolExec(pool: pg.Pool): BackfillExec & { one: (t: string, p?: any[]) => Promise<any> } {
  return {
    rows: async (t, p) => (await pool.query(t, p)).rows,
    run: async (t, p) => (await pool.query(t, p)).rowCount ?? 0,
    one: async (t, p) => (await pool.query(t, p)).rows[0] ?? null,
  };
}

test("ADR-017 D3 backfill — fills null org_id + workspace_tag for known sessions, never guesses", async () => {
  const { url, cleanup } = await createTestStore();
  const pool = new pg.Pool({ connectionString: url });
  const exec = poolExec(pool);
  const WS = "/repos/alpha";
  const wsTag = workspaceTagFromPath(WS)!;
  try {
    // Seed: an org, its owner, one active session in workspace WS, and rows for
    // that session (s1) + rows for a session with NO active_sessions row (s2).
    await exec.run("INSERT INTO organizations (org_id, name, slug) VALUES ($1,$2,$3)", ["org_test", "Test Org", "test-org"]);
    await exec.run("INSERT INTO users (user_id, api_key, created_at, default_org_id) VALUES ($1,$2,$3,$4)", ["u1", "key_u1", "2026-01-01", "org_test"]);
    await exec.run(
      "INSERT INTO active_sessions (session_key, user_id, org_id, workspace_root, started_at, last_heartbeat_at, claim_token, claim_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      ["s1", "u1", "org_test", WS, "2026-01-01", "2026-01-01", "ct1", "2026-12-31"],
    );
    // cognitive_records: r1 (session s1, known) + r2 (session s2, unknown workspace)
    for (const [id, sk] of [["r1", "s1"], ["r2", "s2"]]) {
      await exec.run("INSERT INTO cognitive_records (record_id, user_id, session_key, content, created_time) VALUES ($1,$2,$3,$4,$5)", [id, "u1", sk, "hello", "2026-01-01"]);
    }
    // source_documents: d1 (s1) + d2 (s2); sessionKey lives in metadata_json.
    for (const [id, sk, hash] of [["d1", "s1", "h1"], ["d2", "s2", "h2"]]) {
      await exec.run(
        "INSERT INTO source_documents (id, user_id, kind, hash, title, created_at, metadata_json) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, "u1", "transcript", hash, "t", "2026-01-01", JSON.stringify({ sessionKey: sk, role: "user" })],
      );
    }

    const summary = await backfillScopeTags(exec, { hashWorkspacePath: workspaceTagFromPath });

    // org_id: every row inherits the owner's default org (high coverage).
    assert.equal(summary.orgIdCognitiveRecords, 2);
    assert.equal(summary.orgIdSourceDocuments, 2);
    // workspace_tag: only the known-session rows (s1) get tagged.
    assert.equal(summary.workspaceTagCognitiveRecords, 1);
    assert.equal(summary.workspaceTagSourceDocuments, 1);
    assert.equal(summary.workspaceSessionsApplied, 1);

    const r1 = await exec.one("SELECT org_id, workspace_tag FROM cognitive_records WHERE record_id = 'r1'");
    assert.equal(r1.org_id, "org_test");
    assert.equal(r1.workspace_tag, wsTag);
    const r2 = await exec.one("SELECT org_id, workspace_tag FROM cognitive_records WHERE record_id = 'r2'");
    assert.equal(r2.org_id, "org_test", "org still backfilled for the unknown-workspace row");
    assert.equal(r2.workspace_tag, null, "workspace_tag stays null when the session's workspace is unknown — never guessed");
    const d1 = await exec.one("SELECT org_id, workspace_tag FROM source_documents WHERE id = 'd1'");
    assert.equal(d1.org_id, "org_test");
    assert.equal(d1.workspace_tag, wsTag);
    const d2 = await exec.one("SELECT workspace_tag FROM source_documents WHERE id = 'd2'");
    assert.equal(d2.workspace_tag, null);

    // Idempotent: a second run changes nothing (all fillable columns are set).
    const again = await backfillScopeTags(exec, { hashWorkspacePath: workspaceTagFromPath });
    assert.equal(again.orgIdCognitiveRecords, 0);
    assert.equal(again.orgIdSourceDocuments, 0);
    assert.equal(again.workspaceTagCognitiveRecords, 0);
    assert.equal(again.workspaceTagSourceDocuments, 0);
  } finally {
    await pool.end().catch(() => undefined);
    await cleanup();
  }
});
