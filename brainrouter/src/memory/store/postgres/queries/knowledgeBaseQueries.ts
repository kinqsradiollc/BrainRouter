import type {
  KnowledgeBaseRecord,
  UpdateKnowledgeBaseInput,
} from "../../../../knowledge/contracts/base.js";
import type { Executor } from "./executor.js";

const COLUMNS = "base_id, org_id, project_id, name, description, created_by, created_at, updated_at";

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToRecord(row: any): KnowledgeBaseRecord {
  return {
    baseId: String(row.base_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: String(row.description),
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function createKnowledgeBase(exec: Executor, record: KnowledgeBaseRecord): Promise<void> {
  await exec.run(
    `INSERT INTO knowledge_bases
       (base_id, org_id, project_id, name, description, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      record.baseId,
      record.orgId,
      record.projectId,
      record.name,
      record.description,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
    ],
  );
}

export async function getKnowledgeBase(
  exec: Executor,
  baseId: string,
  orgId: string,
  projectId: string,
): Promise<KnowledgeBaseRecord | null> {
  const row = await exec.one(
    `SELECT ${COLUMNS} FROM knowledge_bases
      WHERE base_id = $1 AND org_id = $2 AND project_id = $3`,
    [baseId, orgId, projectId],
  );
  return row ? rowToRecord(row) : null;
}

export async function listKnowledgeBases(
  exec: Executor,
  orgId: string,
  projectId: string,
): Promise<KnowledgeBaseRecord[]> {
  const rows = await exec.rows(
    `SELECT ${COLUMNS} FROM knowledge_bases
      WHERE org_id = $1 AND project_id = $2
      ORDER BY updated_at DESC, base_id ASC`,
    [orgId, projectId],
  );
  return rows.map(rowToRecord);
}

export async function updateKnowledgeBase(
  exec: Executor,
  baseId: string,
  orgId: string,
  projectId: string,
  patch: UpdateKnowledgeBaseInput & { updatedAt: string },
): Promise<KnowledgeBaseRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [baseId, orgId, projectId];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  params.push(patch.updatedAt);
  sets.push(`updated_at = $${params.length}`);
  const row = await exec.one(
    `UPDATE knowledge_bases SET ${sets.join(", ")}
      WHERE base_id = $1 AND org_id = $2 AND project_id = $3
      RETURNING ${COLUMNS}`,
    params,
  );
  return row ? rowToRecord(row) : null;
}

export async function deleteKnowledgeBase(
  exec: Executor,
  baseId: string,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  return (await exec.run(
    `DELETE FROM knowledge_bases WHERE base_id = $1 AND org_id = $2 AND project_id = $3`,
    [baseId, orgId, projectId],
  )) > 0;
}
