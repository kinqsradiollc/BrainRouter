import { describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentRecord } from "../knowledge/contracts/document.js";
import {
  buildKnowledgeChunks,
  parseJobInput,
  processKnowledgeParseJob,
  type KnowledgeParseProcessorStore,
} from "../knowledge/services/parse-processor.js";

const input = {
  orgId: "org-1",
  projectId: "project-1",
  baseId: "base-1",
  documentId: "document-1",
  parseVersion: 1,
};
const at = "2026-07-22T04:00:00.000Z";

function document(overrides: Partial<KnowledgeDocumentRecord> = {}): KnowledgeDocumentRecord {
  return {
    documentId: "document-1",
    baseId: "base-1",
    orgId: "org-1",
    projectId: "project-1",
    title: "Runbook",
    sourceName: "runbook.md",
    sourceFormat: "markdown",
    contentText: "First line\nSecond line",
    contentSha256: "a".repeat(64),
    status: "queued",
    statusMessage: null,
    parseVersion: 1,
    createdBy: "user-1",
    createdAt: at,
    updatedAt: at,
    readyAt: null,
    ...overrides,
  };
}

function setup(record: KnowledgeDocumentRecord | null = document()) {
  const store: KnowledgeParseProcessorStore = {
    getKnowledgeDocument: vi.fn(async () => record),
    markKnowledgeDocumentParsing: vi.fn(async () => record ? { ...record, status: "parsing" as const } : null),
    commitKnowledgeDocumentParse: vi.fn(async (_input, chunks) => record ? {
      document: { ...record, status: "ready" as const, readyAt: at },
      chunksWritten: chunks.length,
      alreadyReady: record.status === "ready",
    } : null),
    failKnowledgeDocumentParse: vi.fn(async () => record ? { ...record, status: "failed" as const } : null),
  };
  return { store };
}

describe("knowledge parse processor", () => {
  it("validates and normalizes the complete internal job scope", () => {
    expect(parseJobInput({
      orgId: " org-1 ", projectId: " project-1 ", baseId: " base-1 ",
      documentId: " document-1 ", parseVersion: 1,
    })).toEqual(input);
    for (const invalid of [
      null,
      { ...input, orgId: "" },
      { ...input, documentId: "x".repeat(513) },
      { ...input, parseVersion: 2 },
    ]) expect(() => parseJobInput(invalid)).toThrow("Invalid knowledge parse job input");
  });

  it("builds stable content-hashed chunks with source locators", () => {
    const first = buildKnowledgeChunks(document());
    const second = buildKnowledgeChunks(document());
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ordinal: 0,
      content: "First line\nSecond line",
      tokenCount: 6,
      charStart: null,
      charEnd: null,
      locator: { sourceFormat: "markdown", startLine: 1, endLine: 2 },
    });
    expect(first[0]?.chunkId).toMatch(/^kchunk_[0-9a-f]{40}$/);
    expect(first[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks parsing, commits deterministic chunks, and returns a compact summary", async () => {
    const { store } = setup();
    await expect(processKnowledgeParseJob(input, store, { now: () => at })).resolves.toEqual({
      documentId: "document-1",
      chunksWritten: 1,
      alreadyReady: false,
      status: "ready",
    });
    expect(store.markKnowledgeDocumentParsing).toHaveBeenCalledWith(input, at);
    expect(store.commitKnowledgeDocumentParse).toHaveBeenCalledWith(
      input,
      expect.arrayContaining([expect.objectContaining({ ordinal: 0 })]),
      at,
    );
    expect(store.failKnowledgeDocumentParse).not.toHaveBeenCalled();
  });

  it("keeps an already-ready document idempotent without rebuilding chunks", async () => {
    const ready = document({ status: "ready", readyAt: at });
    const { store } = setup(ready);
    vi.mocked(store.markKnowledgeDocumentParsing).mockResolvedValueOnce(ready);
    vi.mocked(store.commitKnowledgeDocumentParse).mockResolvedValueOnce({
      document: ready,
      chunksWritten: 3,
      alreadyReady: true,
    });
    await expect(processKnowledgeParseJob(input, store, { now: () => at }))
      .resolves.toMatchObject({ chunksWritten: 3, alreadyReady: true, status: "ready" });
    expect(store.commitKnowledgeDocumentParse).toHaveBeenCalledWith(input, [], at);
  });

  it("records only a safe failure message and preserves not-found isolation", async () => {
    const broken = setup();
    vi.mocked(broken.store.commitKnowledgeDocumentParse).mockRejectedValueOnce(
      new Error("relation secret_table does not exist"),
    );
    await expect(processKnowledgeParseJob(input, broken.store, { now: () => at }))
      .rejects.toThrow("secret_table");
    expect(broken.store.failKnowledgeDocumentParse).toHaveBeenCalledWith(
      input,
      "Knowledge document parsing failed.",
      at,
    );

    const missing = setup(null);
    await expect(processKnowledgeParseJob(input, missing.store, { now: () => at }))
      .rejects.toThrow("unavailable");
    expect(missing.store.failKnowledgeDocumentParse).not.toHaveBeenCalled();
  });
});
