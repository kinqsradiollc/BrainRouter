import { describe, expect, it, vi } from "vitest";
import {
  searchKnowledgeChunksByText,
  searchKnowledgeChunksByVector,
} from "./knowledgeSearchQueries.js";

const row = {
  chunk_id: "chunk-1",
  document_id: "document-1",
  base_id: "base-1",
  org_id: "org-1",
  project_id: "project-1",
  document_title: "Runbook",
  source_name: "runbook.md",
  ordinal: 2,
  content: "Rotate the signing key.",
  token_count: 5,
  char_start: 10,
  char_end: 33,
  locator_json: { section: "Recovery" },
};

function executor(result: unknown[] = []) {
  return {
    run: vi.fn(),
    one: vi.fn(),
    rows: vi.fn(async () => result),
    tx: vi.fn(),
  } as any;
}

describe("knowledge search queries", () => {
  it("runs bounded lexical search through complete ancestry and ready documents", async () => {
    const exec = executor([{ ...row, text_rank: "0.75" }]);

    await expect(searchKnowledgeChunksByText(exec, {
      orgId: " org-1 ",
      projectId: " project-1 ",
      baseIds: ["base-1", "base-1", " base-2 "],
      limit: 50_000,
    }, " signing key ")).resolves.toEqual([{
      chunkId: "chunk-1",
      documentId: "document-1",
      baseId: "base-1",
      orgId: "org-1",
      projectId: "project-1",
      documentTitle: "Runbook",
      sourceName: "runbook.md",
      ordinal: 2,
      content: "Rotate the signing key.",
      tokenCount: 5,
      charStart: 10,
      charEnd: 33,
      locator: { section: "Recovery" },
      textRank: 0.75,
    }]);
    const [sql, params] = exec.rows.mock.calls[0];
    expect(sql).toContain("document.document_id = chunk.document_id");
    expect(sql).toContain("document.base_id = chunk.base_id");
    expect(sql).toContain("document.org_id = chunk.org_id");
    expect(sql).toContain("document.project_id = chunk.project_id");
    expect(sql).toContain("document.status = 'ready'");
    expect(sql).toContain("chunk.content_tsv @@ plainto_tsquery('english', $4)");
    expect(sql).toContain("ORDER BY text_rank DESC, chunk.document_id ASC, chunk.ordinal ASC");
    expect(params).toEqual([
      "org-1", "project-1", ["base-1", "base-2"], "signing key", 100,
    ]);
  });

  it("searches every Project base when no base filter is supplied", async () => {
    const exec = executor();
    await searchKnowledgeChunksByText(exec, {
      orgId: "org-1",
      projectId: "project-1",
      baseIds: [],
    }, "recovery");
    expect(exec.rows.mock.calls[0][1]).toEqual(["org-1", "project-1", null, "recovery", 20]);
  });

  it("rejects unusable lexical requests without querying", async () => {
    for (const [scope, query] of [
      [{ orgId: "", projectId: "project-1" }, "valid"],
      [{ orgId: "org-1", projectId: "project-1" }, "---"],
      [{ orgId: "org-1", projectId: "project-1", baseIds: Array.from({ length: 101 }, (_, i) => `base-${i}`) }, "valid"],
      [{ orgId: "org-1", projectId: "project-1" }, "x".repeat(4_001)],
    ] as const) {
      const exec = executor();
      await expect(searchKnowledgeChunksByText(exec, scope, query)).resolves.toEqual([]);
      expect(exec.rows).not.toHaveBeenCalled();
    }
  });

  it("materializes a model- and dimension-filtered vector scope before distance", async () => {
    const exec = executor([{ ...row, locator_json: JSON.stringify({ line: 9 }), distance: "0.2" }]);

    await expect(searchKnowledgeChunksByVector(exec, {
      orgId: "org-1",
      projectId: "project-1",
      baseIds: ["base-1"],
      limit: 7,
    }, {
      embeddingModel: " model-a ",
      dimensions: 3,
      embedding: new Float32Array([1, 0, 0]),
    })).resolves.toEqual([{
      chunkId: "chunk-1",
      documentId: "document-1",
      baseId: "base-1",
      orgId: "org-1",
      projectId: "project-1",
      documentTitle: "Runbook",
      sourceName: "runbook.md",
      ordinal: 2,
      content: "Rotate the signing key.",
      tokenCount: 5,
      charStart: 10,
      charEnd: 33,
      locator: { line: 9 },
      vectorScore: 0.8,
    }]);
    const [sql, params] = exec.rows.mock.calls[0];
    expect(sql).toContain("WITH scoped AS MATERIALIZED");
    expect(sql).toContain("embedding.embedding_model = $4 AND embedding.dimensions = $5");
    expect(sql).toContain("document.status = 'ready'");
    expect(sql).not.toContain("SELECT scoped.*");
    expect(sql.indexOf("embedding.dimensions = $5")).toBeLessThan(sql.indexOf("scoped.embedding <=> $6::vector"));
    expect(params).toEqual([
      "org-1", "project-1", ["base-1"], "model-a", 3, "[1,0,0]", 7,
    ]);
  });

  it("rejects malformed vectors without querying", async () => {
    for (const input of [
      { embeddingModel: "", dimensions: 2, embedding: [1, 0] },
      { embeddingModel: "model-a", dimensions: 3, embedding: [1, 0] },
      { embeddingModel: "model-a", dimensions: 2, embedding: [1, Number.NaN] },
      { embeddingModel: "model-a", dimensions: 16_001, embedding: [1] },
    ]) {
      const exec = executor();
      await expect(searchKnowledgeChunksByVector(exec, {
        orgId: "org-1",
        projectId: "project-1",
      }, input)).resolves.toEqual([]);
      expect(exec.rows).not.toHaveBeenCalled();
    }
  });
});
