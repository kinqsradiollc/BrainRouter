import { describe, it, expect } from "vitest";
import { renderRecordMarkdown, renderTreeNodeMarkdown, vaultHash } from "../memory/vault/render.js";
import type { MemoryListItem, MemoryTreeNode } from "@kinqs/brainrouter-types";

const rec: MemoryListItem = {
  recordId: "r1", content: "The router uses RRF.", type: "codebase_fact", priority: 75,
  sceneName: "recall", skillTag: "", createdTime: "2026-05-30T00:00:00Z",
  citationCount: 3, neverCitedCount: 0, archived: false,
};

const node: MemoryTreeNode = {
  id: "t1", userId: "u1", kind: "topic", parentId: null, level: 1,
  summaryMd: "Summary of auth", sourceChunkIds: ["c1", "c2"], sealedAt: null,
  heatScore: 2, createdAt: "2026-05-30T00:00:00Z",
};

describe("vault render (MEM-7)", () => {
  it("record markdown has frontmatter + content", () => {
    const md = renderRecordMarkdown(rec);
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/id: r1/);
    expect(md).toMatch(/type: codebase_fact/);
    expect(md).toMatch(/The router uses RRF\./);
  });

  it("tree-node markdown has frontmatter + summary", () => {
    const md = renderTreeNodeMarkdown(node);
    expect(md).toMatch(/kind: topic/);
    expect(md).toMatch(/chunks: 2/);
    expect(md).toMatch(/Summary of auth/);
  });

  it("render is deterministic → stable hash (drives idempotent re-export)", () => {
    expect(vaultHash(renderRecordMarkdown(rec))).toBe(vaultHash(renderRecordMarkdown(rec)));
    expect(vaultHash(renderRecordMarkdown(rec))).not.toBe(vaultHash(renderTreeNodeMarkdown(node)));
  });
});
