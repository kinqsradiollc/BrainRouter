import { describe, it, expect } from "vitest";
import { ingestRepoFiles } from "../memory/source/ingestRepo.js";
import type { SourceIngestStore } from "../memory/source/ingest.js";
import type { SourceChunk, SourceDocument } from "@kinqs/brainrouter-types";

/** Minimal in-memory SourceIngestStore that reproduces the real store's user+hash
 *  dedup + chunk reuse, so idempotency is exercised without Postgres. */
function fakeStore() {
  const docs = new Map<string, SourceDocument>();
  const chunksByDoc = new Map<string, SourceChunk[]>();
  let n = 0;
  const store: SourceIngestStore = {
    createSourceDocument(input) {
      const key = `${input.userId}:${input.hash}`;
      for (const d of docs.values()) if (`${d.userId}:${d.hash}` === key) return d;
      const doc = { id: `doc_${++n}`, createdAt: "t", ...input } as SourceDocument;
      docs.set(doc.id, doc);
      return doc;
    },
    getSourceChunksByDocument(documentId) {
      return chunksByDoc.get(documentId) ?? [];
    },
    addSourceChunks(documentId, chunks) {
      const out = chunks.map((c, i) => ({ id: `${documentId}_${i}`, documentId, ordinal: i, ...c })) as unknown as SourceChunk[];
      chunksByDoc.set(documentId, out);
      return out;
    },
  };
  return { store, docs, chunksByDoc };
}

describe("ingestRepoFiles (ADR-015 P2)", () => {
  it("ingests text files scoped by repoTag; skips binary, empty, oversized", async () => {
    const { store, docs } = fakeStore();
    const files = [
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "bin.dat", content: `abc${String.fromCharCode(0)}def` }, // binary (NUL)
      { path: "empty.txt", content: "   " }, // whitespace-only
      { path: "big.txt", content: "x".repeat(300_000) }, // oversized
    ];
    const res = await ingestRepoFiles(store, files, { userId: "u1", repoTag: "deadbeefdeadbeef" });
    expect(res.ingested).toBe(1);
    expect(res.skipped).toBe(3);
    const doc = [...docs.values()][0];
    expect(doc.kind).toBe("file");
    expect(doc.workspaceTag).toBe("deadbeefdeadbeef");
    expect(doc.uri).toBe("src/a.ts");
    expect((doc.metadata as Record<string, unknown>)?.repoTag).toBe("deadbeefdeadbeef");
  });

  it("is idempotent on identical content (user+hash dedup) — re-run adds no new chunks", async () => {
    const { store, docs } = fakeStore();
    const files = [{ path: "a.ts", content: "const a = 1;" }];
    const first = await ingestRepoFiles(store, files, { userId: "u", repoTag: "t" });
    const second = await ingestRepoFiles(store, files, { userId: "u", repoTag: "t" });
    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(1);
    expect(second.chunks).toBe(first.chunks);
    expect(docs.size).toBe(1); // no duplicate document
  });

  it("caps file count and reports truncation", async () => {
    const { store } = fakeStore();
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, content: `const x${i}=1;` }));
    const res = await ingestRepoFiles(store, files, { userId: "u", repoTag: "t", maxFiles: 2 });
    expect(res.ingested).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("empty repoTag → unscoped (workspaceTag null)", async () => {
    const { store, docs } = fakeStore();
    await ingestRepoFiles(store, [{ path: "a.ts", content: "const a=1;" }], { userId: "u", repoTag: "" });
    expect([...docs.values()][0].workspaceTag).toBeNull();
  });
});
