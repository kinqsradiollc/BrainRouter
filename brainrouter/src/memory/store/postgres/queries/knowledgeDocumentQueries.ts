import type {
  KnowledgeDocumentListFilters,
  KnowledgeDocumentRecord,
  KnowledgeDocumentStatusUpdate,
} from "../../../../knowledge/contracts/document.js";
import type { Executor } from "./executor.js";

const COLUMNS = `document_id, base_id, org_id, project_id, title, source_name,
  source_format, content_text, content_sha256, status, status_message,
  parse_version, created_by, created_at, updated_at, ready_at`;

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : toIso(value);
}

function rowToRecord(row: any): KnowledgeDocumentRecord {
  return {
    documentId: String(row.document_id),
    baseId: String(row.base_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    title: String(row.title),
    sourceName: String(row.source_name),
    sourceFormat: row.source_format,
    contentText: String(row.content_text),
    contentSha256: String(row.content_sha256),
    status: row.status,
    statusMessage: row.status_message == null ? null : String(row.status_message),
    parseVersion: Number(row.parse_version),
    createdBy: String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    readyAt: nullableIso(row.ready_at),
  };
}

export async function createKnowledgeDocument(
  exec: Executor,
  record: KnowledgeDocumentRecord,
): Promise<void> {
  await exec.run(
    `INSERT INTO knowledge_documents
       (document_id, base_id, org_id, project_id, title, source_name,
        source_format, content_text, content_sha256, status, status_message,
        parse_version, created_by, created_at, updated_at, ready_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      record.documentId,
      record.baseId,
      record.orgId,
      record.projectId,
      record.title,
      record.sourceName,
      record.sourceFormat,
      record.contentText,
      record.contentSha256,
      record.status,
      record.statusMessage,
      record.parseVersion,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
      record.readyAt,
    ],
  );
}

export async function getKnowledgeDocument(
  exec: Executor,
  documentId: string,
  baseId: string,
  orgId: string,
  projectId: string,
): Promise<KnowledgeDocumentRecord | null> {
  const row = await exec.one(
    `SELECT ${COLUMNS} FROM knowledge_documents
      WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
    [documentId, baseId, orgId, projectId],
  );
  return row ? rowToRecord(row) : null;
}

export async function getKnowledgeDocumentByContentHash(
  exec: Executor,
  contentSha256: string,
  baseId: string,
  orgId: string,
  projectId: string,
): Promise<KnowledgeDocumentRecord | null> {
  const row = await exec.one(
    `SELECT ${COLUMNS} FROM knowledge_documents
      WHERE content_sha256 = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
    [contentSha256, baseId, orgId, projectId],
  );
  return row ? rowToRecord(row) : null;
}

export async function listKnowledgeDocuments(
  exec: Executor,
  baseId: string,
  orgId: string,
  projectId: string,
  filters: KnowledgeDocumentListFilters = {},
): Promise<KnowledgeDocumentRecord[]> {
  const params: unknown[] = [baseId, orgId, projectId];
  const where = ["base_id = $1", "org_id = $2", "project_id = $3"];
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  const requestedLimit = filters.limit ?? 100;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
    : 100;
  params.push(limit);
  const rows = await exec.rows(
    `SELECT ${COLUMNS} FROM knowledge_documents
      WHERE ${where.join(" AND ")}
      ORDER BY updated_at DESC, document_id ASC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToRecord);
}

export async function updateKnowledgeDocumentStatus(
  exec: Executor,
  documentId: string,
  baseId: string,
  orgId: string,
  projectId: string,
  update: KnowledgeDocumentStatusUpdate,
): Promise<KnowledgeDocumentRecord | null> {
  const row = await exec.one(
    `UPDATE knowledge_documents
        SET status = $5, status_message = $6, updated_at = $7, ready_at = $8
      WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
      RETURNING ${COLUMNS}`,
    [
      documentId,
      baseId,
      orgId,
      projectId,
      update.status,
      update.statusMessage,
      update.updatedAt,
      update.readyAt,
    ],
  );
  return row ? rowToRecord(row) : null;
}
