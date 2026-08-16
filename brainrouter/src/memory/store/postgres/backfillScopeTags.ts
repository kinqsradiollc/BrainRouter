/**
 * ADR-017 D3 — idempotent backfill of scope columns on already-captured rows.
 *
 * PR2/PR3 stamp `org_id` + `workspace_tag` (+ `project_tag`) on every NEW
 * capture, but rows written before that landed carry NULLs, so per-org and
 * per-workspace recall silently under-scopes them. This backfill fills what can
 * be known WITHOUT guessing:
 *
 *   - `org_id` ← the owner's `users.default_org_id` (pure SQL; high coverage).
 *     Re-affirms migration 019's source_documents pass and extends it to
 *     cognitive_records + any rows written after 019 but before PR2.
 *   - `workspace_tag` ← the hash of `active_sessions.workspace_root` for the
 *     row's session (JS hash, so a script — not a SQL migration). Coverage is
 *     bounded to sessions still present in `active_sessions` (they are swept on
 *     staleness), which is exactly the "workspace-known rows only, never guess"
 *     contract from the ADR. Source docs carry their `sessionKey` in
 *     `metadata_json`; cognitive records carry it in the `session_key` column.
 *
 * `project_tag` is deliberately NOT backfilled: nothing in the historical data
 * records which Project a row belonged to (no stored project name to hash), and
 * the ADR forbids guessing. Going forward PR3 populates it at capture time.
 *
 * Every write guards on `IS NULL`, so the backfill is safe to re-run and never
 * overwrites a scope that a later, better-scoped capture already set.
 */

/** The minimal query surface the backfill needs (a pg Pool adapter satisfies it). */
export interface BackfillExec {
  rows<T = any>(text: string, params?: any[]): Promise<T[]>;
  /** Returns the affected row count (like `Pool.query(...).rowCount`). */
  run(text: string, params?: any[]): Promise<number>;
}

export interface BackfillScopeTagsDeps {
  /** Hash a workspace root to its stable 16-char tag; null when unhashable. */
  hashWorkspacePath: (root: string | null | undefined) => string | null;
  log?: (message: string) => void;
}

export interface BackfillScopeTagsSummary {
  orgIdSourceDocuments: number;
  orgIdCognitiveRecords: number;
  workspaceTagSourceDocuments: number;
  workspaceTagCognitiveRecords: number;
  /** Distinct (session_key, workspace_root) pairs that yielded a usable tag. */
  workspaceSessionsApplied: number;
  /** Sessions seen in active_sessions with a workspace_root but no usable hash. */
  workspaceSessionsSkipped: number;
}

export async function backfillScopeTags(
  exec: BackfillExec,
  deps: BackfillScopeTagsDeps,
): Promise<BackfillScopeTagsSummary> {
  const log = deps.log ?? (() => {});
  const summary: BackfillScopeTagsSummary = {
    orgIdSourceDocuments: 0,
    orgIdCognitiveRecords: 0,
    workspaceTagSourceDocuments: 0,
    workspaceTagCognitiveRecords: 0,
    workspaceSessionsApplied: 0,
    workspaceSessionsSkipped: 0,
  };

  // 1. org_id ← users.default_org_id (idempotent; only NULL rows).
  summary.orgIdSourceDocuments = await exec.run(
    `UPDATE source_documents d
        SET org_id = u.default_org_id
       FROM users u
      WHERE d.user_id = u.user_id
        AND d.org_id IS NULL
        AND u.default_org_id IS NOT NULL`,
  );
  summary.orgIdCognitiveRecords = await exec.run(
    `UPDATE cognitive_records r
        SET org_id = u.default_org_id
       FROM users u
      WHERE r.user_id = u.user_id
        AND r.org_id IS NULL
        AND u.default_org_id IS NOT NULL`,
  );
  log(`org_id: source_documents=${summary.orgIdSourceDocuments}, cognitive_records=${summary.orgIdCognitiveRecords}`);

  // 2. workspace_tag ← hash(active_sessions.workspace_root), per session.
  const sessions = await exec.rows<{ session_key: string; workspace_root: string }>(
    `SELECT DISTINCT session_key, workspace_root
       FROM active_sessions
      WHERE COALESCE(workspace_root, '') <> ''`,
  );
  for (const s of sessions) {
    const tag = deps.hashWorkspacePath(s.workspace_root);
    if (!tag) {
      summary.workspaceSessionsSkipped += 1;
      continue;
    }
    summary.workspaceSessionsApplied += 1;
    summary.workspaceTagCognitiveRecords += await exec.run(
      `UPDATE cognitive_records
          SET workspace_tag = $1
        WHERE workspace_tag IS NULL
          AND session_key = $2`,
      [tag, s.session_key],
    );
    // Source docs record their session in metadata_json ({ sessionKey, role }).
    summary.workspaceTagSourceDocuments += await exec.run(
      `UPDATE source_documents
          SET workspace_tag = $1
        WHERE workspace_tag IS NULL
          AND (metadata_json::jsonb ->> 'sessionKey') = $2`,
      [tag, s.session_key],
    );
  }
  log(
    `workspace_tag: source_documents=${summary.workspaceTagSourceDocuments}, ` +
      `cognitive_records=${summary.workspaceTagCognitiveRecords} ` +
      `(from ${summary.workspaceSessionsApplied} session(s); ${summary.workspaceSessionsSkipped} skipped)`,
  );
  log("project_tag: not backfilled (no historical project marker to hash — never guessed).");

  return summary;
}
