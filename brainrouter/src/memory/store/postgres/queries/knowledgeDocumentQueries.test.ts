import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_PARSE_JOB_KIND,
  type KnowledgeDocumentRecord,
} from "../../../../knowledge/contracts/document.js";
import {
  createKnowledgeDocument,
  commitKnowledgeDocumentParse,
  enqueueDerivedKnowledgeDocuments,
  enqueueKnowledgeDocument,
  failKnowledgeDocumentParse,
  getKnowledgeDocument,
  getKnowledgeDocumentByContentHash,
  getKnowledgeDocumentProcessing,
  listKnowledgeDocuments,
  listKnowledgeDocumentSourceIds,
  listKnowledgeChunks,
  markKnowledgeDocumentParsing,
  retryKnowledgeDocumentProcessing,
  updateKnowledgeDocumentStatus,
  upsertKnowledgeChunkEmbeddings,
} from "./knowledgeDocumentQueries.js";

const at = "2026-07-22T00:00:00.000Z";
const row = {
  document_id: "doc-1",
  base_id: "base-1",
  org_id: "org-1",
  project_id: "project-1",
  title: "Runbook",
  source_name: "runbook.md",
  source_format: "markdown",
  content_text: "# Runbook",
  content_sha256: "a".repeat(64),
  origin: "source",
  distillation_version: null,
  status: "queued",
  status_message: null,
  parse_version: 1,
  created_by: "user-1",
  created_at: new Date(at),
  updated_at: new Date(at),
  ready_at: null,
};

const record: KnowledgeDocumentRecord = {
  documentId: "doc-1",
  baseId: "base-1",
  orgId: "org-1",
  projectId: "project-1",
  title: "Runbook",
  sourceName: "runbook.md",
  sourceFormat: "markdown",
  contentText: "# Runbook",
  contentSha256: "a".repeat(64),
  origin: "source",
  distillationVersion: null,
  status: "queued",
  statusMessage: null,
  parseVersion: 1,
  createdBy: "user-1",
  createdAt: at,
  updatedAt: at,
  readyAt: null,
};

const parseInput = {
  orgId: "org-1",
  projectId: "project-1",
  baseId: "base-1",
  documentId: "doc-1",
  parseVersion: 1,
};

function executor(result: unknown = row) {
  return {
    run: vi.fn(async () => 1),
    one: vi.fn(async () => result),
    rows: vi.fn(async () => result ? [result] : []),
    tx: vi.fn(),
  } as any;
}

describe("knowledge document queries", () => {
  it("inserts every server-owned document field with parameters", async () => {
    const exec = executor();
    await createKnowledgeDocument(exec, record);

    expect(exec.run).toHaveBeenCalledOnce();
    const [sql, params] = exec.run.mock.calls[0];
    expect(sql).toContain("INSERT INTO knowledge_documents");
    expect(params).toEqual([
      "doc-1", "base-1", "org-1", "project-1", "Runbook", "runbook.md",
      "markdown", "# Runbook", "a".repeat(64), "source", null, "queued", null, 1,
      "user-1", at, at, null,
    ]);
  });

  it("requires document, base, organization, and Project scope for reads", async () => {
    const exec = executor();
    await expect(getKnowledgeDocument(exec, "doc-1", "base-1", "org-1", "project-1"))
      .resolves.toEqual(record);
    const [idSql, idParams] = exec.one.mock.calls[0];
    expect(idSql).toContain("document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4");
    expect(idParams).toEqual(["doc-1", "base-1", "org-1", "project-1"]);

    await getKnowledgeDocumentByContentHash(exec, "a".repeat(64), "base-1", "org-1", "project-1");
    const [hashSql, hashParams] = exec.one.mock.calls[1];
    expect(hashSql).toContain("content_sha256 = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4");
    expect(hashParams).toEqual(["a".repeat(64), "base-1", "org-1", "project-1"]);
  });

  it("bounds scoped listings and optionally filters by status and origin", async () => {
    const exec = executor();
    await expect(listKnowledgeDocuments(exec, "base-1", "org-1", "project-1", {
      status: "queued",
      origin: "source",
      limit: 50_000,
    })).resolves.toEqual([record]);
    const [sql, params] = exec.rows.mock.calls[0];
    expect(sql).toContain("base_id = $1 AND org_id = $2 AND project_id = $3");
    expect(sql).toContain("status = $4");
    expect(sql).toContain("origin = $5");
    expect(sql).toContain("LIMIT $6");
    expect(params).toEqual(["base-1", "org-1", "project-1", "queued", "source", 500]);

    await listKnowledgeDocuments(exec, "base-1", "org-1", "project-1", { limit: Number.NaN });
    expect(exec.rows.mock.calls[1][1]).toEqual(["base-1", "org-1", "project-1", 100]);
  });

  it("updates lifecycle truth only through the complete ancestry key", async () => {
    const exec = executor({ ...row, status: "ready", ready_at: new Date(at) });
    await expect(updateKnowledgeDocumentStatus(
      exec,
      "doc-1",
      "base-1",
      "org-1",
      "project-1",
      { status: "ready", statusMessage: null, updatedAt: at, readyAt: at },
    )).resolves.toEqual({ ...record, status: "ready", readyAt: at });
    const [sql, params] = exec.one.mock.calls[0];
    expect(sql).toContain("document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4");
    expect(params).toEqual([
      "doc-1", "base-1", "org-1", "project-1", "ready", null, at, at,
    ]);
  });

  it("atomically inserts a document and content-free tenant parse job", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(enqueueKnowledgeDocument(exec, record, "job-1")).resolves.toEqual({
      document: record,
      created: true,
      jobId: "job-1",
    });
    expect(exec.tx).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledTimes(2);
    const [jobSql, jobParams] = client.query.mock.calls[1];
    expect(jobSql).toContain("INSERT INTO memory_jobs");
    expect(jobParams[1]).toBe(KNOWLEDGE_PARSE_JOB_KIND);
    expect(jobParams[3]).toBe("org-1");
    expect(JSON.parse(jobParams[4])).toEqual({
      orgId: "org-1",
      projectId: "project-1",
      baseId: "base-1",
      documentId: "doc-1",
      parseVersion: 1,
    });
    expect(jobParams.join(" ")).not.toContain("# Runbook");
  });

  it("returns the scoped dedupe row without creating another parse job", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [row] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(enqueueKnowledgeDocument(exec, record, "unused-job")).resolves.toEqual({
      document: record,
      created: false,
      jobId: null,
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain(
      "content_sha256 = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4",
    );
  });

  it("atomically stores derived notes only from ready source documents", async () => {
    const derivedRow = {
      ...row,
      document_id: "derived-1",
      title: "Derived",
      content_text: "# Derived",
      content_sha256: "b".repeat(64),
      origin: "derived",
      distillation_version: 1,
    };
    const derivedRecord: KnowledgeDocumentRecord = {
      ...record,
      documentId: "derived-1",
      title: "Derived",
      contentText: "# Derived",
      contentSha256: "b".repeat(64),
      origin: "derived",
      distillationVersion: 1,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ document_id: "doc-1" }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [derivedRow] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(enqueueDerivedKnowledgeDocuments(exec, [{
      document: derivedRecord,
      sourceDocumentIds: ["doc-1"],
      jobId: "derived-job",
    }])).resolves.toEqual([{
      document: derivedRecord,
      sourceDocumentIds: ["doc-1"],
      created: true,
      jobId: "derived-job",
    }]);
    expect(client.query.mock.calls[0][0]).toContain(
      "status = 'ready' AND origin = 'source'",
    );
    expect(client.query.mock.calls[0][1]).toEqual([
      "base-1", "org-1", "project-1", ["doc-1"],
    ]);
    expect(client.query.mock.calls[2][0]).toContain(
      "INSERT INTO knowledge_document_provenance",
    );
    expect(client.query.mock.calls[3][0]).toContain("INSERT INTO memory_jobs");
    expect(client.query.mock.calls[3][1].join(" ")).not.toContain("# Derived");
  });

  it("fails closed before writes when a derived or unready source is requested", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(enqueueDerivedKnowledgeDocuments(exec, [{
      document: {
        ...record,
        documentId: "derived-1",
        contentSha256: "b".repeat(64),
        origin: "derived",
        distillationVersion: 1,
      },
      sourceDocumentIds: ["derived-source"],
      jobId: "unused",
    }])).rejects.toThrow("sources are unavailable");
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("lists provenance through the complete derived-document ancestry", async () => {
    const exec = executor();
    exec.rows.mockResolvedValueOnce([
      { source_document_id: "source-2" },
      { source_document_id: "source-1" },
    ]);

    await expect(listKnowledgeDocumentSourceIds(
      exec,
      "derived-1",
      "base-1",
      "org-1",
      "project-1",
    )).resolves.toEqual(["source-2", "source-1"]);
    expect(exec.rows.mock.calls[0][0]).toContain(
      "derived_document_id = $1 AND base_id = $2",
    );
    expect(exec.rows.mock.calls[0][1]).toEqual([
      "derived-1", "base-1", "org-1", "project-1",
    ]);
  });

  it("marks parsing and failure only through ancestry plus parse version", async () => {
    const parsingExec = executor({ ...row, status: "parsing" });
    await expect(markKnowledgeDocumentParsing(parsingExec, parseInput, at))
      .resolves.toEqual({ ...record, status: "parsing" });
    expect(parsingExec.one.mock.calls[0][0]).toContain("parse_version = $5 AND status <> 'ready'");
    expect(parsingExec.one.mock.calls[0][1]).toEqual([
      "doc-1", "base-1", "org-1", "project-1", 1, at,
    ]);

    const failedExec = executor({ ...row, status: "failed", status_message: "safe" });
    await expect(failKnowledgeDocumentParse(failedExec, parseInput, "safe", at))
      .resolves.toEqual({ ...record, status: "failed", statusMessage: "safe" });
    expect(failedExec.one.mock.calls[0][0]).toContain("parse_version = $5 AND status <> 'ready'");
    expect(failedExec.one.mock.calls[0][1]).toEqual([
      "doc-1", "base-1", "org-1", "project-1", 1, "safe", at,
    ]);
  });

  it("transactionally replaces chunks and marks the document ready", async () => {
    const readyRow = { ...row, status: "ready", updated_at: new Date(at), ready_at: new Date(at) };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));
    const chunks = [{
      chunkId: "chunk-1",
      ordinal: 0,
      content: "# Runbook",
      contentSha256: "b".repeat(64),
      tokenCount: 3,
      charStart: null,
      charEnd: null,
      locator: { startLine: 1, endLine: 1 },
    }];

    await expect(commitKnowledgeDocumentParse(exec, parseInput, chunks, at)).resolves.toEqual({
      document: { ...record, status: "ready", readyAt: at },
      chunksWritten: 1,
      alreadyReady: false,
    });
    expect(exec.tx).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1][0]).toContain("DELETE FROM knowledge_chunks");
    expect(client.query.mock.calls[2][0]).toContain("jsonb_to_recordset");
    expect(JSON.parse(client.query.mock.calls[2][1][4])).toEqual([{
      chunk_id: "chunk-1",
      ordinal: 0,
      content: "# Runbook",
      content_sha256: "b".repeat(64),
      token_count: 3,
      char_start: null,
      char_end: null,
      locator_json: { startLine: 1, endLine: 1 },
    }]);
    expect(client.query.mock.calls[3][0]).toContain("SET status = 'ready'");
  });

  it("treats a locked ready document as an idempotent no-op", async () => {
    const readyRow = { ...row, status: "ready", ready_at: new Date(at) };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: "2" }] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(commitKnowledgeDocumentParse(exec, parseInput, [], at)).resolves.toEqual({
      document: { ...record, status: "ready", readyAt: at },
      chunksWritten: 2,
      alreadyReady: true,
    });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain("COUNT(*)");
  });

  it("lists parsed chunks through the complete document ancestry", async () => {
    const chunkRow = {
      chunk_id: "chunk-1",
      document_id: "doc-1",
      base_id: "base-1",
      org_id: "org-1",
      project_id: "project-1",
      ordinal: 0,
      content: "# Runbook",
      content_sha256: "b".repeat(64),
      token_count: 3,
      char_start: null,
      char_end: null,
      locator_json: { startLine: 1, endLine: 1 },
      created_at: new Date(at),
    };
    const exec = executor();
    exec.rows.mockResolvedValueOnce([chunkRow]);
    await expect(listKnowledgeChunks(exec, "doc-1", "base-1", "org-1", "project-1"))
      .resolves.toEqual([{
        chunkId: "chunk-1",
        documentId: "doc-1",
        baseId: "base-1",
        orgId: "org-1",
        projectId: "project-1",
        ordinal: 0,
        content: "# Runbook",
        contentSha256: "b".repeat(64),
        tokenCount: 3,
        charStart: null,
        charEnd: null,
        locator: { startLine: 1, endLine: 1 },
        createdAt: at,
      }]);
    expect(exec.rows.mock.calls[0][0]).toContain(
      "document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4",
    );
    expect(exec.rows.mock.calls[0][1]).toEqual(["doc-1", "base-1", "org-1", "project-1"]);
  });

  it("upserts model and dimension tagged embeddings only through scoped chunks", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));
    await expect(upsertKnowledgeChunkEmbeddings(exec, parseInput, [{
      chunkId: "chunk-1",
      embeddingModel: "embed-model",
      dimensions: 3,
      embedding: [0.25, -0.5, 0.75],
    }], at)).resolves.toBe(1);

    expect(client.query.mock.calls[0][0]).toContain(
      "document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4",
    );
    expect(client.query.mock.calls[0][0]).toContain("parse_version = $5 AND status = 'ready'");
    const [sql, params] = client.query.mock.calls[1];
    expect(sql).toContain("JOIN knowledge_chunks chunk");
    expect(sql).toContain("ON CONFLICT (chunk_id, embedding_model) DO UPDATE");
    expect(params.slice(0, 4)).toEqual(["doc-1", "base-1", "org-1", "project-1"]);
    expect(JSON.parse(params[4])).toEqual([{
      chunk_id: "chunk-1",
      embedding_model: "embed-model",
      dimensions: 3,
      embedding_text: "[0.25,-0.5,0.75]",
    }]);
    expect(params[5]).toBe(at);
  });

  it("returns scoped lifecycle state and aggregate processing counts", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...row, status: "failed" }] })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ status: "failed", attempts: 3, max_attempts: 3 }],
        })
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ chunk_count: 2, embedding_count: 4 }],
        }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(getKnowledgeDocumentProcessing(exec, parseInput)).resolves.toEqual({
      document: { ...record, status: "failed" },
      jobState: "failed",
      attempts: 3,
      maxAttempts: 3,
      chunkCount: 2,
      embeddingCount: 4,
    });
    expect(client.query.mock.calls[0][0]).toContain(
      "document_id = $1 AND base_id = $2 AND org_id = $3 AND project_id = $4",
    );
    expect(client.query.mock.calls[0][0]).toContain("parse_version = $5");
    const [jobSql, jobParams] = client.query.mock.calls[1];
    expect(jobSql).toContain("kind = $1 AND tenant = $2");
    expect(jobParams.slice(0, 2)).toEqual([KNOWLEDGE_PARSE_JOB_KIND, "org-1"]);
    expect(JSON.parse(jobParams[2])).toEqual(parseInput);
    expect(client.query.mock.calls[2][0]).toContain(
      "chunk.document_id = $1 AND chunk.base_id = $2",
    );
    expect(client.query.mock.calls[2][1]).toEqual([
      "doc-1", "base-1", "org-1", "project-1",
    ]);
  });

  it("deduplicates retry while an exact scoped job is active", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [row] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "running" }] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(retryKnowledgeDocumentProcessing(exec, parseInput, "unused", at))
      .resolves.toEqual({ document: record, jobState: "running", enqueued: false });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0][0]).toContain("FOR UPDATE");
    const [activeSql, activeParams] = client.query.mock.calls[1];
    expect(activeSql).toContain("kind = $1 AND tenant = $2");
    expect(activeSql).toContain("status IN ('pending', 'running')");
    expect(activeParams.slice(0, 2)).toEqual([KNOWLEDGE_PARSE_JOB_KIND, "org-1"]);
    expect(JSON.parse(activeParams[2])).toEqual(parseInput);
  });

  it("resets a failed document and enqueues a content-free retry", async () => {
    const failedRow = { ...row, status: "failed", status_message: "safe failure" };
    const queuedRow = { ...row, status: "queued", updated_at: new Date(at) };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [failedRow] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [queuedRow] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(retryKnowledgeDocumentProcessing(exec, parseInput, "retry-job", at))
      .resolves.toEqual({ document: record, jobState: "pending", enqueued: true });
    expect(client.query.mock.calls[2][0]).toContain(
      "SET status = 'queued', status_message = NULL, ready_at = NULL",
    );
    const [insertSql, insertParams] = client.query.mock.calls[3];
    expect(insertSql).toContain("INSERT INTO memory_jobs");
    expect(insertParams[0]).toBe("retry-job");
    expect(insertParams[1]).toBe(KNOWLEDGE_PARSE_JOB_KIND);
    expect(insertParams[3]).toBe("org-1");
    expect(JSON.parse(insertParams[4])).toEqual(parseInput);
    expect(insertParams.join(" ")).not.toContain("# Runbook");
  });

  it("keeps a ready document ready while retrying its embeddings", async () => {
    const readyRow = { ...row, status: "ready", ready_at: new Date(at) };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    };
    const exec = executor();
    exec.tx = vi.fn(async (fn: (value: unknown) => Promise<unknown>) => fn(client));

    await expect(retryKnowledgeDocumentProcessing(exec, parseInput, "embed-retry", at))
      .resolves.toEqual({
        document: { ...record, status: "ready", readyAt: at },
        jobState: "pending",
        enqueued: true,
      });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toContain("INSERT INTO memory_jobs");
    expect(client.query.mock.calls.some(([sql]: [string]) => sql.includes("UPDATE knowledge_documents")))
      .toBe(false);
  });
});
