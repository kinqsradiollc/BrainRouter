import { describe, it, expect } from "vitest";
import { chunkSource, estimateTokens } from "../memory/source/chunker.js";
import { ingestSource, type SourceIngestStore } from "../memory/source/ingest.js";
import type { SourceDocument, SourceChunk } from "@kinqs/brainrouter-types";

describe("chunkSource (MEM-2)", () => {
  it("returns nothing for empty / whitespace", () => {
    expect(chunkSource("")).toEqual([]);
    expect(chunkSource("   \n  ")).toEqual([]);
  });

  it("packs whole lines up to the budget; line numbers are 1-based and contiguous", () => {
    // 1 token per line, budget 2 → [1-2], [3-4], [5]
    const chunks = chunkSource("a\nb\nc\nd\ne", { maxTokens: 2, estimate: () => 1 });
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([[1, 2], [3, 4], [5, 5]]);
    expect(chunks.map((c) => c.content)).toEqual(["a\nb", "c\nd", "e"]);
  });

  it("never splits mid-line: an over-budget line stands alone", () => {
    const big = "x".repeat(4000); // ~1000 tokens at chars/4
    const chunks = chunkSource(`small\n${big}\ntail`, { maxTokens: 500 });
    expect(chunks.some((c) => c.content === big)).toBe(true);
    // the big line is its own chunk, not merged with neighbours
    const bigChunk = chunks.find((c) => c.content === big)!;
    expect(bigChunk.startLine).toBe(2);
    expect(bigChunk.endLine).toBe(2);
  });

  it("stamps a token estimate on each chunk", () => {
    const [chunk] = chunkSource("hello world");
    expect(chunk.tokenCount).toBe(estimateTokens("hello world"));
  });
});

describe("ingestSource (MEM-2)", () => {
  function fakeStore() {
    const docs = new Map<string, SourceDocument>();
    const byHash = new Map<string, SourceDocument>();
    const chunks: SourceChunk[] = [];
    let n = 0;
    const store: SourceIngestStore = {
      createSourceDocument(input) {
        const key = `${input.userId}:${input.hash}`;
        const existing = byHash.get(key);
        if (existing) return existing;
        const doc = { ...input, id: `doc${++n}`, createdAt: "t" } as SourceDocument;
        docs.set(doc.id, doc);
        byHash.set(key, doc);
        return doc;
      },
      getSourceChunksByDocument(documentId) {
        return chunks.filter((c) => c.documentId === documentId);
      },
      addSourceChunks(documentId, inputs) {
        const out = inputs.map((c, i): SourceChunk => ({
          ...c,
          id: `c${++n}`, documentId, ordinal: i, hash: `h${n}`,
          filePath: c.filePath ?? null, symbol: c.symbol ?? null, startLine: c.startLine ?? null, endLine: c.endLine ?? null,
        }));
        chunks.push(...out);
        return out;
      },
    };
    return { store, chunks };
  }

  it("creates a document and its chunks", () => {
    const { store } = fakeStore();
    const { document, chunks } = ingestSource(store, { userId: "u", kind: "tool_output", uri: "npm test", hash: "h1", title: "t" } as any, "line one\nline two");
    expect(document.id).toBe("doc1");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("is idempotent: re-ingesting the same doc reuses existing chunks (no duplication)", () => {
    const { store } = fakeStore();
    const doc = { userId: "u", kind: "file", uri: "a.ts", hash: "fa", title: "a.ts" } as any;
    const first = ingestSource(store, doc, "alpha\nbeta");
    const second = ingestSource(store, doc, "alpha\nbeta");
    expect(second.document.id).toBe(first.document.id);
    expect(second.chunks.map((c) => c.id)).toEqual(first.chunks.map((c) => c.id)); // same chunks, not new
  });
});
