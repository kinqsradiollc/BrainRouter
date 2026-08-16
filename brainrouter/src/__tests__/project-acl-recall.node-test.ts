import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createTestStore } from "./helpers/pgTestStore.js";

/**
 * ADR-017 D4 — `listInaccessibleRestrictedProjectNames` is the recall-side ACL
 * source: it returns the NAMES of restricted Projects a caller may not access
 * (recall hashes them to project_tags and drops matching records). Verifies the
 * three access outcomes + that non-restricted projects never appear.
 */
test("ADR-017 D4 — restricted-project denylist: non-member denied, member + org-admin allowed", async () => {
  const { store, url, cleanup } = await createTestStore();
  const pool = new pg.Pool({ connectionString: url });
  const run = async (t: string, p?: any[]) => { await pool.query(t, p); };
  try {
    await run("INSERT INTO organizations (org_id, name, slug) VALUES ($1,$2,$3)", ["org1", "Org One", "org-one"]);
    for (const u of ["u_admin", "u_mem", "u_out"]) {
      await run("INSERT INTO users (user_id, api_key, created_at) VALUES ($1,$2,$3)", [u, `key_${u}`, "2026-01-01"]);
    }
    // Org roles: u_admin is an org admin (bypasses); u_mem + u_out are developers.
    await run("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", ["org1", "u_admin", "admin"]);
    await run("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", ["org1", "u_mem", "developer"]);
    await run("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", ["org1", "u_out", "developer"]);

    // A restricted project (u_mem is a project member) + an open project.
    await store.createProject({ projectId: "p_secret", orgId: "org1", name: "Secret Project", slug: "secret", repoUrl: null, restricted: true, createdBy: "u_admin", createdAt: "2026-01-01" });
    await store.createProject({ projectId: "p_open", orgId: "org1", name: "Open Project", slug: "open", repoUrl: null, restricted: false, createdBy: "u_admin", createdAt: "2026-01-01" });
    await store.addProjectMember("p_secret", "u_mem", "member", "2026-01-01");

    // Non-member developer → the restricted project is denied.
    assert.deepEqual(await store.listInaccessibleRestrictedProjectNames("org1", "u_out"), ["Secret Project"]);
    // Project member → nothing denied.
    assert.deepEqual(await store.listInaccessibleRestrictedProjectNames("org1", "u_mem"), []);
    // Org admin → bypasses restriction, nothing denied.
    assert.deepEqual(await store.listInaccessibleRestrictedProjectNames("org1", "u_admin"), []);
  } finally {
    await pool.end().catch(() => undefined);
    await cleanup();
  }
});
