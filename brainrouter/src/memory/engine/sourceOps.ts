import { createHash } from "node:crypto";
import type { SourceChunk, SourceDocument, RelatedChunkHit } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { chunkSource } from "../source/chunker.js";
import { chunkCode } from "../source/code-chunker.js";
import {
  extractChunkQueryTerms,
  languageScopeFor,
  rankRelatedChunks,
  extractImportSpecifiers,
  resolveRelativeImport,
} from "../recall/code-retrieval.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the source-document / code-chunk engine
 * operations, extracted verbatim from MemoryEngine as free functions taking the
 * engine instance (type-only import → no runtime cycle). `engine.ts`'s methods
 * are now thin wrappers delegating here. No behavior change.
 */

export async function rechunkSources(engine: MemoryEngine, userId: string, documentIds: string[]): Promise<{ rechunked: number; skipped: number; chunksWritten: number }> {
  const store = engine.store as any;
  if (typeof store.getSourceChunksByDocument !== "function" || typeof store.replaceSourceChunks !== "function") {
    return { rechunked: 0, skipped: 0, chunksWritten: 0 };
  }
  let rechunked = 0;
  let skipped = 0;
  let chunksWritten = 0;
  for (const docId of documentIds) {
    const doc = await store.getSourceDocument?.(docId);
    if (!doc || doc.userId !== userId) { skipped++; continue; }          // ownership (MEM-14)
    if (await store.isSourceDocumentReferenced(docId)) { skipped++; continue; } // provenance-safe
    const chunks = (await store.getSourceChunksByDocument(docId)) as SourceChunk[];
    if (chunks.length === 0) { skipped++; continue; }
    const text = [...chunks].sort((a, b) => a.ordinal - b.ordinal).map((c) => c.content).join("\n");
    const isCode = doc.kind === "file" || doc.kind === "code";
    const fresh = isCode ? chunkCode(text) : chunkSource(text);
    const written = (await store.replaceSourceChunks(docId, fresh)) as SourceChunk[];
    rechunked++;
    chunksWritten += written.length;
  }
  return { rechunked, skipped, chunksWritten };
}

export async function pruneTranscriptSources(engine: MemoryEngine, userId: string, olderThanDays: number): Promise<{ prunedDocs: number; prunedChunks: number }> {
  const store = engine.store as any;
  if (typeof store.pruneTranscriptSources !== "function") {
    return { prunedDocs: 0, prunedChunks: 0 };
  }
  const days = Number.isFinite(olderThanDays) && olderThanDays >= 0 ? olderThanDays : 30;
  const beforeIso = new Date(Date.now() - days * 86_400_000).toISOString();
  return store.pruneTranscriptSources(userId, beforeIso);
}

export async function getRecordProvenance(engine: MemoryEngine, userId: string, recordId: string): Promise<Array<{
  chunkId: string;
  documentId: string;
  excerpt: string;
  filePath: string | null;
  symbol: string | null;
  startLine: number | null;
  endLine: number | null;
}>> {
  const store = engine.store as Partial<{ getRecordSourceChunks(userId: string, id: string): Promise<SourceChunk[]> }>;
  if (typeof store.getRecordSourceChunks !== "function") return [];
  return (await store.getRecordSourceChunks(userId, recordId)).map((c) => ({
    chunkId: c.id,
    documentId: c.documentId,
    excerpt: c.content.length > 280 ? `${c.content.slice(0, 280)}…` : c.content,
    filePath: c.filePath,
    symbol: c.symbol,
    startLine: c.startLine,
    endLine: c.endLine,
  }));
}

export async function fetchSourceChunk(
  engine: MemoryEngine,
  userId: string,
  chunkId: string,
  neighbors = 0,
): Promise<{ chunk: SourceChunk; document: SourceDocument | null; neighbors: SourceChunk[] } | null> {
  const store = engine.store as Partial<{
    getSourceChunk(id: string): Promise<SourceChunk | null>;
    getSourceDocument(id: string): Promise<SourceDocument | null>;
    getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]>;
  }>;
  if (typeof store.getSourceChunk !== "function") return null;
  const chunk = await store.getSourceChunk(chunkId);
  if (!chunk) return null;
  const document =
    typeof store.getSourceDocument === "function" ? await store.getSourceDocument(chunk.documentId) : null;
  // Ownership gate: the chunk's parent document must belong to the caller.
  // (source_chunks/source_documents carry user_id per MEM-14.) Without this a
  // user could fetch any chunk by id — cross-tenant leak.
  if (!document || document.userId !== userId) return null;
  let neighborChunks: SourceChunk[] = [];
  if (neighbors > 0 && typeof store.getSourceChunksByDocument === "function") {
    neighborChunks = (await store
      .getSourceChunksByDocument(chunk.documentId))
      .filter((c) => c.id !== chunk.id && Math.abs(c.ordinal - chunk.ordinal) <= neighbors);
  }
  return { chunk, document, neighbors: neighborChunks };
}

export async function findRelatedChunks(
  engine: MemoryEngine,
  userId: string,
  seed: { chunkId?: string; filePath?: string; line?: number },
  opts?: { limit?: number; sameLanguage?: boolean; maxPerFile?: number; includeEdges?: boolean },
): Promise<{ found: boolean; seed?: { chunkId: string; filePath: string | null; symbol: string | null }; related: RelatedChunkHit[] }> {
  const store = engine.store as Partial<{
    getSourceChunk(id: string): Promise<SourceChunk | null>;
    getSourceChunkByFileLine(userId: string, filePath: string, line: number): Promise<SourceChunk | null>;
    searchSourceChunksFts(
      userId: string,
      query: string,
      limit: number,
      opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
    ): Promise<Array<SourceChunk & { ftsRank: number }>>;
    getSourceDocument(id: string): Promise<SourceDocument | null>;
    getCodeEdgeNeighbors(userId: string, chunkId: string, direction: "callees" | "callers"): Promise<SourceChunk[]>;
    getSourceChunksByDocument(documentId: string): Promise<SourceChunk[]>;
    findImportedDocument(userId: string, candidateBase: string): Promise<SourceDocument | null>;
  }>;
  if (typeof store.searchSourceChunksFts !== "function") return { found: false, related: [] };

  // Resolve the seed chunk (by id, or by file:line span).
  let seedChunk: SourceChunk | null = null;
  if (seed.chunkId && typeof store.getSourceChunk === "function") {
    seedChunk = await store.getSourceChunk(seed.chunkId);
  } else if (seed.filePath && typeof seed.line === "number" && typeof store.getSourceChunkByFileLine === "function") {
    seedChunk = await store.getSourceChunkByFileLine(userId, seed.filePath, seed.line);
  }
  if (!seedChunk) return { found: false, related: [] };

  // Ownership gate — mirror fetchSourceChunk: the seed's parent document must
  // belong to the caller (the FTS search is already user-scoped for results).
  const doc = typeof store.getSourceDocument === "function" ? await store.getSourceDocument(seedChunk.documentId) : null;
  if (!doc || doc.userId !== userId) return { found: false, related: [] };

  const limit = Math.max(1, Math.min(50, opts?.limit ?? 10));
  const seedInfo = { chunkId: seedChunk.id, filePath: seedChunk.filePath, symbol: seedChunk.symbol };

  // MEM-28 — structural neighbours lead: the seed's direct callees/callers
  // (intra-file symbol edges) are authoritatively related regardless of
  // lexical overlap or language scope (they're in the same file), so they're
  // surfaced even when the seed has no extractable query terms.
  const edgeHits: RelatedChunkHit[] = [];
  if (opts?.includeEdges !== false && typeof store.getCodeEdgeNeighbors === "function") {
    for (const c of await store.getCodeEdgeNeighbors(userId, seedChunk.id, "callees")) {
      edgeHits.push({ chunk: c, score: 0.97, reason: "graph:callee" });
    }
    for (const c of await store.getCodeEdgeNeighbors(userId, seedChunk.id, "callers")) {
      edgeHits.push({ chunk: c, score: 0.95, reason: "graph:caller" });
    }
  }

  // MEM-28b — cross-file import edges: resolve the seed FILE's relative imports
  // to indexed documents and surface a lead chunk from each (a callee often
  // lives in an imported file). Resolved lazily here (order-independent).
  const importHits: RelatedChunkHit[] = [];
  if (
    opts?.includeEdges !== false && doc.uri &&
    typeof store.getSourceChunksByDocument === "function" &&
    typeof store.findImportedDocument === "function"
  ) {
    const fileChunks = await store.getSourceChunksByDocument(seedChunk.documentId);
    const specifiers = extractImportSpecifiers(fileChunks.map((c) => c.content).join("\n"));
    const seenDocs = new Set<string>([seedChunk.documentId]);
    let added = 0;
    for (const spec of specifiers) {
      if (added >= 5) break;
      const base = resolveRelativeImport(doc.uri, spec);
      if (!base) continue;
      const importedDoc = await store.findImportedDocument(userId, base);
      if (!importedDoc || seenDocs.has(importedDoc.id)) continue;
      seenDocs.add(importedDoc.id);
      const chunks = await store.getSourceChunksByDocument(importedDoc.id);
      const lead = chunks.find((c) => c.symbol) ?? chunks[0];
      if (lead) { importHits.push({ chunk: lead, score: 0.9, reason: "graph:import" }); added++; }
    }
  }

  // Lexical neighbours (symbol/identifier overlap), code-reranked (MEM-26/27).
  const query = extractChunkQueryTerms(seedChunk);
  const scope = opts?.sameLanguage === false ? [] : languageScopeFor(seedChunk.filePath);
  const lexical = query
    ? rankRelatedChunks(
        seedChunk,
        await store.searchSourceChunksFts(userId, query, limit, { excludeChunkId: seedChunk.id, filePathLike: scope.length ? scope : undefined }),
        limit,
        { maxPerFile: opts?.maxPerFile },
      )
    : [];

  // Merge: structural edges first, then lexical; dedupe by chunk id (an edge
  // entry wins over a lexical one for the same chunk), exclude the seed, cap.
  const merged: RelatedChunkHit[] = [];
  const seen = new Set<string>([seedChunk.id]);
  for (const h of [...edgeHits, ...importHits, ...lexical]) {
    if (seen.has(h.chunk.id)) continue;
    seen.add(h.chunk.id);
    merged.push(h);
    if (merged.length >= limit) break;
  }

  return { found: true, seed: seedInfo, related: merged };
}

export async function reindexCodeSource(
  engine: MemoryEngine,
  userId: string,
  input: { filePath: string; content: string; language?: string; title?: string; commitCount90d?: number | null; lastCommitDate?: string | null },
): Promise<{ status: "fresh" | "reindexed" | "unsupported"; documentId?: string; staleMarked: number; chunks: number }> {
  const store = engine.store as Partial<{
    lookupDocumentByPathHash(userId: string, uri: string, hash: string): Promise<{ id: string; stale: boolean } | null>;
    markSourceDocumentsStaleByPath(userId: string, uri: string): Promise<number>;
    reviveSourceDocument(documentId: string): Promise<void>;
    createSourceDocument(input: any): Promise<SourceDocument>;
    addSourceChunks(documentId: string, chunks: any[]): Promise<SourceChunk[]>;
    setSourceDocumentChurn(documentId: string, commitCount90d: number | null, lastCommitDate: string | null): Promise<void>;
  }>;
  // B7 (MEM-CHURN) — stamp the captured churn signal onto whichever document
  // this reindex resolves to (fresh / revived / new). NULL when not provided.
  const stampChurn = (documentId: string) =>
    store.setSourceDocumentChurn?.(documentId, input.commitCount90d ?? null, input.lastCommitDate ?? null);
  if (
    typeof store.lookupDocumentByPathHash !== "function" ||
    typeof store.createSourceDocument !== "function" ||
    typeof store.addSourceChunks !== "function"
  ) {
    return { status: "unsupported", staleMarked: 0, chunks: 0 };
  }

  const hash = createHash("sha1").update(input.content ?? "").digest("hex");
  const existing = await store.lookupDocumentByPathHash(userId, input.filePath, hash);
  if (existing && !existing.stale) {
    await stampChurn(existing.id); // churn can change even when content doesn't
    return { status: "fresh", documentId: existing.id, staleMarked: 0, chunks: 0 };
  }

  const staleMarked = (await store.markSourceDocumentsStaleByPath?.(userId, input.filePath)) ?? 0;

  // Revert case — this exact content was indexed before (now staled). Revive
  // it rather than duplicate; its chunks + edges are still intact.
  if (existing) {
    await store.reviveSourceDocument?.(existing.id);
    await stampChurn(existing.id);
    return { status: "reindexed", documentId: existing.id, staleMarked, chunks: 0 };
  }

  const doc = await store.createSourceDocument({
    userId,
    workspaceTag: null,
    kind: "file",
    uri: input.filePath,
    hash,
    title: input.title ?? input.filePath,
  });
  const stored = await store.addSourceChunks(doc.id, chunkCode(input.content ?? "", { filePath: input.filePath, language: input.language }));
  await stampChurn(doc.id);
  return { status: "reindexed", documentId: doc.id, staleMarked, chunks: stored.length };
}
