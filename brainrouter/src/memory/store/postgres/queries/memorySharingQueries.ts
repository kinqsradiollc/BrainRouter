/**
 * Artifact / memory sharing (ADR-014 Phase D). Promote a record from `private` to
 * `org` visibility (share with the Team) and browse the Team's shared pool.
 * Additive — exposed via `memoryEngine.sharing`, like the tenancy cast.
 */
import type { Executor } from "./executor.js";

export interface SharedMemory {
  recordId: string;
  userId: string;
  content: string;
  type: string;
  priority: number;
  skillTag: string;
  visibility: string;
  createdTime: string;
}

/**
 * Set a record's visibility (+ owning org). ONLY the record's owner can change its
 * own sharing — the `user_id = $2` guard makes cross-user tampering impossible.
 * Returns true when a row was updated.
 */
export async function setMemoryVisibility(
  exec: Executor,
  recordId: string,
  userId: string,
  orgId: string,
  visibility: "private" | "team" | "org",
  teamId?: string | null,
): Promise<boolean> {
  const n = await exec.run(
    `UPDATE cognitive_records SET visibility = $4, org_id = $3, team_id = $5
       WHERE record_id = $1 AND user_id = $2`,
    [recordId, userId, orgId, visibility, visibility === "team" ? teamId ?? null : null],
  );
  return n > 0;
}

/** The Team's shared pool (visibility='org') across all members, newest first. */
export async function listOrgSharedMemories(exec: Executor, orgId: string, limit = 50): Promise<SharedMemory[]> {
  const rows = await exec.rows<any>(
    `SELECT record_id, user_id, content, type, priority, skill_tag, visibility, created_time
       FROM cognitive_records
      WHERE org_id = $1 AND visibility = 'org' AND invalid_at IS NULL
      ORDER BY created_time DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map((r) => ({
    recordId: String(r.record_id), userId: String(r.user_id), content: String(r.content ?? ""),
    type: String(r.type ?? ""), priority: Number(r.priority ?? 0), skillTag: String(r.skill_tag ?? ""),
    visibility: String(r.visibility ?? "org"), createdTime: String(r.created_time ?? ""),
  }));
}
