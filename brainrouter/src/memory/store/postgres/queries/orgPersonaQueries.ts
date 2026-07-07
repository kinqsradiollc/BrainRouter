/**
 * Team (org) consensus-persona persistence (ADR-014 Phase C). Additive — kept
 * out of the shared `IMemoryStore` (which CLI/desktop consume) and exposed via
 * `memoryEngine.orgPersona`, like the tenancy cast.
 */
import type { Executor } from "./executor.js";

export interface OrgIdentityRecord {
  orgId: string;
  personaMd: string;
  cognitiveCountAtGeneration: number;
  createdTime: string;
  updatedTime: string;
}

/** The Team's SHARED persona/instruction memories — the raw material for the overlay. */
export async function getOrgSharedIdentityCognitives(exec: Executor, orgId: string, limit = 100): Promise<any[]> {
  return exec.rows(
    `SELECT record_id, content, type, priority, skill_tag, created_time
       FROM cognitive_records
      WHERE org_id = $1 AND visibility = 'org' AND type IN ('persona','instruction') AND invalid_at IS NULL
      ORDER BY priority DESC, created_time DESC LIMIT $2`,
    [orgId, limit],
  );
}

export async function getOrgIdentity(exec: Executor, orgId: string): Promise<OrgIdentityRecord | null> {
  const row = await exec.one<any>(
    `SELECT org_id, persona_md, cognitive_count_at_generation, created_time, updated_time
       FROM org_identity WHERE org_id = $1`,
    [orgId],
  );
  if (!row) return null;
  return {
    orgId: String(row.org_id), personaMd: String(row.persona_md),
    cognitiveCountAtGeneration: Number(row.cognitive_count_at_generation ?? 0),
    createdTime: String(row.created_time ?? ""), updatedTime: String(row.updated_time ?? ""),
  };
}

export async function upsertOrgIdentity(exec: Executor, rec: OrgIdentityRecord): Promise<void> {
  await exec.run(
    `INSERT INTO org_identity (org_id, persona_md, cognitive_count_at_generation, created_time, updated_time)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id) DO UPDATE SET
       persona_md = EXCLUDED.persona_md,
       cognitive_count_at_generation = EXCLUDED.cognitive_count_at_generation,
       updated_time = EXCLUDED.updated_time`,
    [rec.orgId, rec.personaMd, rec.cognitiveCountAtGeneration, rec.createdTime, rec.updatedTime],
  );
}
