import type {
  KnowledgeChunkEmbeddingInput,
  KnowledgeChunkInput,
  KnowledgeChunkRecord,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentListFilters,
  KnowledgeDocumentProcessingRecord,
  KnowledgeDocumentRetryRecord,
  KnowledgeParseJobInput,
  KnowledgeParseCommitResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentStatusUpdate,
} from "../../../../knowledge/contracts/document.js";
import { KNOWLEDGE_PARSE_JOB_KIND } from "../../../../knowledge/contracts/document.js";
import { toVectorLiteral } from "../converters.js";
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

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function insertParams(record: KnowledgeDocumentRecord): unknown[] {
  return [
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
  ];
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
    insertParams(record),
  );
}

export async function enqueueKnowledgeDocument(
  exec: Executor,
  record: KnowledgeDocumentRecord,
  jobId: string,
): Promise<KnowledgeDocumentEnqueueResult> {
  return exec.tx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO knowledge_documents
         (document_id, base_id, org_id, project_id, title, source_name,
          source_format, content_text, content_sha256, status, status_message,
          parse_version, created_by, created_at, updated_at, ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (org_id, project_id, base_id, content_sha256) DO NOTHING
       RETURNING ${COLUMNS}`,
      insertParams(record),
    );
    if ((inserted.rowCount ?? 0) === 0) {
      const existing = (await client.query(
        `SELECT ${COLUMNS} FROM knowledge_documents
          WHERE content_sha256 = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
        [record.contentSha256, record.baseId, record.orgId, record.projectId],
      )).rows[0];
      if (!existing) throw new Error("Knowledge document dedupe row disappeared.");
      return { document: rowToRecord(existing), created: false, jobId: null };
    }

    const input: KnowledgeParseJobInput = {
      orgId: record.orgId,
      projectId: record.projectId,
      baseId: record.baseId,
      documentId: record.documentId,
      parseVersion: record.parseVersion,
    };
    await client.query(
      `INSERT INTO memory_jobs
         (id, kind, status, priority, attempts, max_attempts, run_after,
          locked_at, parent_job_id, tenant, input_json, output_json, error,
          created_at, updated_at)
       VALUES ($1,$2,'pending',50,0,3,$3,NULL,NULL,$4,$5,NULL,NULL,$6,$7)`,
      [
        jobId,
        KNOWLEDGE_PARSE_JOB_KIND,
        record.createdAt,
        record.orgId,
        JSON.stringify(input),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return { document: rowToRecord(inserted.rows[0]), created: true, jobId };
  });
}

export async function markKnowledgeDocumentParsing(
  exec: Executor,
  input: KnowledgeParseJobInput,
  updatedAt: string,
): Promise<KnowledgeDocumentRecord | null> {
  const row = await exec.one(
    `UPDATE knowledge_documents
        SET status = 'parsing', status_message = NULL, updated_at = $6, ready_at = NULL
      WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
        AND parse_version = $5 AND status <> 'ready'
      RETURNING ${COLUMNS}`,
    [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion, updatedAt],
  );
  if (row) return rowToRecord(row);
  return getKnowledgeDocument(
    exec,
    input.documentId,
    input.baseId,
    input.orgId,
    input.projectId,
  );
}

export async function commitKnowledgeDocumentParse(
  exec: Executor,
  input: KnowledgeParseJobInput,
  chunks: KnowledgeChunkInput[],
  readyAt: string,
): Promise<KnowledgeParseCommitResult | null> {
  return exec.tx(async (client) => {
    const current = (await client.query(
      `SELECT ${COLUMNS} FROM knowledge_documents
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
          AND parse_version = $5
        FOR UPDATE`,
      [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion],
    )).rows[0];
    if (!current) return null;
    const document = rowToRecord(current);
    if (document.status === "ready") {
      const count = (await client.query(
        `SELECT COUNT(*) AS count FROM knowledge_chunks
          WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
        [input.documentId, input.baseId, input.orgId, input.projectId],
      )).rows[0];
      return { document, chunksWritten: Number(count?.count ?? 0), alreadyReady: true };
    }

    await client.query(
      `DELETE FROM knowledge_chunks
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4`,
      [input.documentId, input.baseId, input.orgId, input.projectId],
    );
    if (chunks.length > 0) {
      await client.query(
        `INSERT INTO knowledge_chunks
           (chunk_id, document_id, base_id, org_id, project_id, ordinal, content,
            content_sha256, token_count, char_start, char_end, locator_json)
         SELECT chunk.chunk_id, $1, $2, $3, $4, chunk.ordinal, chunk.content,
                chunk.content_sha256, chunk.token_count, chunk.char_start,
                chunk.char_end, chunk.locator_json
           FROM jsonb_to_recordset($5::jsonb) AS chunk(
             chunk_id text, ordinal integer, content text, content_sha256 text,
             token_count integer, char_start integer, char_end integer,
             locator_json jsonb
           )`,
        [
          input.documentId,
          input.baseId,
          input.orgId,
          input.projectId,
          JSON.stringify(chunks.map((chunk) => ({
            chunk_id: chunk.chunkId,
            ordinal: chunk.ordinal,
            content: chunk.content,
            content_sha256: chunk.contentSha256,
            token_count: chunk.tokenCount,
            char_start: chunk.charStart,
            char_end: chunk.charEnd,
            locator_json: chunk.locator,
          }))),
        ],
      );
    }
    const ready = (await client.query(
      `UPDATE knowledge_documents
          SET status = 'ready', status_message = NULL, updated_at = $6, ready_at = $6
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
          AND parse_version = $5
        RETURNING ${COLUMNS}`,
      [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion, readyAt],
    )).rows[0];
    if (!ready) throw new Error("Knowledge document disappeared during parse commit.");
    return { document: rowToRecord(ready), chunksWritten: chunks.length, alreadyReady: false };
  });
}

export async function failKnowledgeDocumentParse(
  exec: Executor,
  input: KnowledgeParseJobInput,
  statusMessage: string,
  updatedAt: string,
): Promise<KnowledgeDocumentRecord | null> {
  const row = await exec.one(
    `UPDATE knowledge_documents
        SET status = 'failed', status_message = $6, updated_at = $7, ready_at = NULL
      WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
        AND parse_version = $5 AND status <> 'ready'
      RETURNING ${COLUMNS}`,
    [
      input.documentId,
      input.baseId,
      input.orgId,
      input.projectId,
      input.parseVersion,
      statusMessage,
      updatedAt,
    ],
  );
  return row ? rowToRecord(row) : null;
}

export async function listKnowledgeChunks(
  exec: Executor,
  documentId: string,
  baseId: string,
  orgId: string,
  projectId: string,
): Promise<KnowledgeChunkRecord[]> {
  const rows = await exec.rows(
    `SELECT chunk_id, document_id, base_id, org_id, project_id, ordinal,
            content, content_sha256, token_count, char_start, char_end,
            locator_json, created_at
       FROM knowledge_chunks
      WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
      ORDER BY ordinal ASC`,
    [documentId, baseId, orgId, projectId],
  );
  return rows.map((row: any) => ({
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    baseId: String(row.base_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    ordinal: Number(row.ordinal),
    content: String(row.content),
    contentSha256: String(row.content_sha256),
    tokenCount: Number(row.token_count),
    charStart: row.char_start == null ? null : Number(row.char_start),
    charEnd: row.char_end == null ? null : Number(row.char_end),
    locator: jsonObject(row.locator_json),
    createdAt: toIso(row.created_at),
  }));
}

export async function upsertKnowledgeChunkEmbeddings(
  exec: Executor,
  input: KnowledgeParseJobInput,
  embeddings: KnowledgeChunkEmbeddingInput[],
  updatedAt: string,
): Promise<number> {
  if (embeddings.length === 0) return 0;
  return exec.tx(async (client) => {
    const document = await client.query(
      `SELECT 1 FROM knowledge_documents
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
          AND parse_version = $5 AND status = 'ready'
        FOR SHARE`,
      [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion],
    );
    if ((document.rowCount ?? 0) !== 1) {
      throw new Error("Knowledge document is unavailable for embedding.");
    }
    const payload = embeddings.map((embedding) => ({
      chunk_id: embedding.chunkId,
      embedding_model: embedding.embeddingModel,
      dimensions: embedding.dimensions,
      embedding_text: toVectorLiteral(embedding.embedding),
    }));
    const result = await client.query(
      `WITH payload AS (
         SELECT * FROM jsonb_to_recordset($5::jsonb) AS item(
           chunk_id text, embedding_model text, dimensions integer, embedding_text text
         )
       )
       INSERT INTO knowledge_chunk_embeddings
         (chunk_id, document_id, base_id, org_id, project_id, embedding_model,
          dimensions, embedding, created_at, updated_at)
       SELECT chunk.chunk_id, chunk.document_id, chunk.base_id, chunk.org_id,
              chunk.project_id, payload.embedding_model, payload.dimensions,
              payload.embedding_text::vector, $6, $6
         FROM payload
         JOIN knowledge_chunks chunk
           ON chunk.chunk_id = payload.chunk_id
          AND chunk.document_id = $1 AND chunk.base_id = $2
          AND chunk.org_id = $3 AND chunk.project_id = $4
       ON CONFLICT (chunk_id, embedding_model) DO UPDATE
         SET dimensions = EXCLUDED.dimensions,
             embedding = EXCLUDED.embedding,
             updated_at = EXCLUDED.updated_at`,
      [
        input.documentId,
        input.baseId,
        input.orgId,
        input.projectId,
        JSON.stringify(payload),
        updatedAt,
      ],
    );
    if ((result.rowCount ?? 0) !== embeddings.length) {
      throw new Error("Knowledge chunks changed during embedding.");
    }
    return result.rowCount ?? 0;
  });
}

export async function getKnowledgeDocumentProcessing(
  exec: Executor,
  input: KnowledgeParseJobInput,
): Promise<KnowledgeDocumentProcessingRecord | null> {
  return exec.tx(async (client) => {
    const documentRow = (await client.query(
      `SELECT ${COLUMNS} FROM knowledge_documents
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
          AND parse_version = $5`,
      [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion],
    )).rows[0];
    if (!documentRow) return null;
    const scopeJson = JSON.stringify(input);
    const jobRow = (await client.query(
      `SELECT status, attempts, max_attempts
         FROM memory_jobs
        WHERE kind = $1 AND tenant = $2 AND input_json::jsonb @> $3::jsonb
        ORDER BY created_at DESC, updated_at DESC, id DESC
        LIMIT 1`,
      [KNOWLEDGE_PARSE_JOB_KIND, input.orgId, scopeJson],
    )).rows[0];
    const counts = (await client.query(
      `SELECT COUNT(DISTINCT chunk.chunk_id)::int AS chunk_count,
              COUNT(embedding.chunk_id)::int AS embedding_count
         FROM knowledge_chunks chunk
         LEFT JOIN knowledge_chunk_embeddings embedding
           ON embedding.chunk_id = chunk.chunk_id
          AND embedding.document_id = chunk.document_id
          AND embedding.base_id = chunk.base_id
          AND embedding.org_id = chunk.org_id
          AND embedding.project_id = chunk.project_id
        WHERE chunk.document_id = $1 AND chunk.base_id = $2
          AND chunk.org_id = $3 AND chunk.project_id = $4`,
      [input.documentId, input.baseId, input.orgId, input.projectId],
    )).rows[0];
    return {
      document: rowToRecord(documentRow),
      jobState: processingJobState(jobRow?.status),
      attempts: Number(jobRow?.attempts ?? 0),
      maxAttempts: Number(jobRow?.max_attempts ?? 0),
      chunkCount: Number(counts?.chunk_count ?? 0),
      embeddingCount: Number(counts?.embedding_count ?? 0),
    };
  });
}

export async function retryKnowledgeDocumentProcessing(
  exec: Executor,
  input: KnowledgeParseJobInput,
  jobId: string,
  now: string,
): Promise<KnowledgeDocumentRetryRecord | null> {
  return exec.tx(async (client) => {
    let documentRow = (await client.query(
      `SELECT ${COLUMNS} FROM knowledge_documents
        WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
          AND parse_version = $5
        FOR UPDATE`,
      [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion],
    )).rows[0];
    if (!documentRow) return null;
    const scopeJson = JSON.stringify(input);
    const active = (await client.query(
      `SELECT status FROM memory_jobs
        WHERE kind = $1 AND tenant = $2 AND input_json::jsonb @> $3::jsonb
          AND status IN ('pending', 'running')
        ORDER BY created_at DESC, updated_at DESC, id DESC
        LIMIT 1`,
      [KNOWLEDGE_PARSE_JOB_KIND, input.orgId, scopeJson],
    )).rows[0];
    if (active) {
      return {
        document: rowToRecord(documentRow),
        jobState: active.status === "running" ? "running" : "pending",
        enqueued: false,
      };
    }
    if (String(documentRow.status) !== "ready") {
      documentRow = (await client.query(
        `UPDATE knowledge_documents
            SET status = 'queued', status_message = NULL, ready_at = NULL, updated_at = $6
          WHERE document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4
            AND parse_version = $5
          RETURNING ${COLUMNS}`,
        [input.documentId, input.baseId, input.orgId, input.projectId, input.parseVersion, now],
      )).rows[0];
    }
    await client.query(
      `INSERT INTO memory_jobs
         (id, kind, status, priority, attempts, max_attempts, run_after,
          locked_at, parent_job_id, tenant, input_json, output_json, progress_json,
          error, created_at, updated_at)
       VALUES ($1,$2,'pending',50,0,3,$3,NULL,NULL,$4,$5,NULL,'[]',NULL,$6,$7)`,
      [jobId, KNOWLEDGE_PARSE_JOB_KIND, now, input.orgId, scopeJson, now, now],
    );
    return { document: rowToRecord(documentRow), jobState: "pending", enqueued: true };
  });
}

function processingJobState(value: unknown): KnowledgeDocumentProcessingRecord["jobState"] {
  return value === "pending" || value === "running" || value === "done"
    || value === "failed" || value === "cancelled"
    ? value
    : "missing";
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
