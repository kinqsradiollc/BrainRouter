import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentRecord } from "../../../../knowledge/contracts/document.js";
import {
  createKnowledgeDocument,
  getKnowledgeDocument,
  getKnowledgeDocumentByContentHash,
  listKnowledgeDocuments,
  updateKnowledgeDocumentStatus,
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
  status: "queued",
  statusMessage: null,
  parseVersion: 1,
  createdBy: "user-1",
  createdAt: at,
  updatedAt: at,
  readyAt: null,
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
      "markdown", "# Runbook", "a".repeat(64), "queued", null, 1,
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

  it("bounds scoped listings and optionally filters by status", async () => {
    const exec = executor();
    await expect(listKnowledgeDocuments(exec, "base-1", "org-1", "project-1", {
      status: "queued",
      limit: 50_000,
    })).resolves.toEqual([record]);
    const [sql, params] = exec.rows.mock.calls[0];
    expect(sql).toContain("base_id = $1 AND org_id = $2 AND project_id = $3");
    expect(sql).toContain("status = $4");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual(["base-1", "org-1", "project-1", "queued", 500]);

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
});
