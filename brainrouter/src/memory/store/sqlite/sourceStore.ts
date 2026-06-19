/**
 * ADR-004 Phase 3 — Source documents & chunks capability (Group E).
 *
 * Extracted VERBATIM from `SqliteMemoryStore`: this group is self-contained —
 * every method touches only its own tables (`source_documents`,
 * `source_chunks`, `code_symbol_edges`, `cognitive_source_links`) via
 * `this.db` plus the two private row mappers, with no cross-capability calls.
 * `SqliteMemoryStore` composes one of these and delegates, so the public
 * `IMemoryStore` surface is unchanged.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import type { SourceDocument, SourceChunk, SourceChunkInput } from "@kinqs/brainrouter-types";
import { extractIntraFileCallEdges } from "../../recall/code-retrieval.js";
import { buildFtsQuery } from "./converters.js";

export class SqliteSourceStore {
  constructor(private readonly db: DatabaseSync) {}

  private rowToSourceDocument(row: any): SourceDocument {
    return {
      id: row.id,
      userId: row.user_id,
      workspaceTag: row.workspace_tag ?? null,
      kind: row.kind,
      uri: row.uri ?? null,
      hash: row.hash,
      title: row.title ?? "",
      createdAt: row.created_at,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    };
  }

  private rowToSourceChunk(row: any): SourceChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      ordinal: row.ordinal,
      content: row.content,
      tokenCount: row.token_count,
      filePath: row.file_path ?? null,
      symbol: row.symbol ?? null,
      startLine: row.start_line ?? null,
      endLine: row.end_line ?? null,
      hash: row.hash,
    };
  }

  public getSourceDocumentByHash(userId: string, hash: string): SourceDocument | null {
    const row = this.db.prepare("SELECT * FROM source_documents WHERE user_id = ? AND hash = ? LIMIT 1").get(userId, hash) as any;
    return row ? this.rowToSourceDocument(row) : null;
  }

  public getSourceDocument(id: string): SourceDocument | null {
    const row = this.db.prepare("SELECT * FROM source_documents WHERE id = ?").get(id) as any;
    return row ? this.rowToSourceDocument(row) : null;
  }

  /**
   * B6 (0.4.11) — true if a NON-stale source document still exists at this uri.
   * `/memory verify` uses it to tell a re-anchorable memory (its file changed →
   * a fresh doc exists at the uri) from a dead-anchor one (only stale docs left →
   * the file is gone), so apply only archives the confirmed-dead.
   */
  public hasFreshSourceDocument(userId: string, uri: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM source_documents WHERE user_id = ? AND uri = ? AND COALESCE(stale, 0) = 0 LIMIT 1",
    ).get(userId, uri);
    return !!row;
  }

  /** B7 (MEM-CHURN) — record a document's recent-churn signal (captured at index time). */
  public setSourceDocumentChurn(documentId: string, commitCount90d: number | null, lastCommitDate: string | null): void {
    this.db.prepare(
      "UPDATE source_documents SET commit_count_90d = ?, last_commit_date = ? WHERE id = ?",
    ).run(commitCount90d, lastCommitDate, documentId);
  }

  /**
   * B7 (MEM-CHURN) — max recent-churn across each record's anchored source files,
   * for a batch of record ids. Records with no code anchor or zero churn are
   * OMITTED (callers then leave their decay unchanged). One query for the set.
   */
  public getRecordsMaxChurn(userId: string, recordIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (recordIds.length === 0) return out;
    const placeholders = recordIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT l.record_id AS rid, MAX(COALESCE(d.commit_count_90d, 0)) AS churn
         FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
         JOIN source_documents d ON d.id = sc.document_id
        WHERE l.user_id = ? AND l.record_id IN (${placeholders})
        GROUP BY l.record_id
        HAVING churn > 0`,
    ).all(userId, ...recordIds) as any[];
    for (const r of rows) out.set(String(r.rid), Number(r.churn));
    return out;
  }

  /** List a user's source documents (newest first) + their chunk counts — powers the dashboard Sources view. */
  public getSourceDocuments(userId: string, limit = 100): Array<SourceDocument & { chunkCount: number }> {
    const rows = this.db.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.document_id = d.id) AS chunk_count
         FROM source_documents d
        WHERE d.user_id = ?
        ORDER BY d.created_at DESC
        LIMIT ?`,
    ).all(userId, limit) as any[];
    return rows.map((r) => ({ ...this.rowToSourceDocument(r), chunkCount: (r.chunk_count as number) ?? 0 }));
  }

  /**
   * 0.4.3 — provenance-safe transcript retention. Every `/sources` row is an
   * auto-ingested per-turn transcript and there was no retention, so they grow
   * unbounded. This deletes `transcript` documents older than `beforeIso`
   * EXCEPT any whose chunks are still referenced by a cognitive_source_link
   * (i.e. a live memory was distilled from them) — so memory_verify /
   * provenance drill-down never breaks. Scoped by user_id (MEM-14).
   *
   * FK cascade is declared but NOT enforced in this store (no
   * `PRAGMA foreign_keys = ON`), so chunks are deleted explicitly. Returns the
   * counts removed. Non-transcript kinds are never touched.
   */
  public pruneTranscriptSources(userId: string, beforeIso: string): { prunedDocs: number; prunedChunks: number } {
    const doomed = this.db.prepare(
      `SELECT d.id FROM source_documents d
        WHERE d.user_id = ? AND d.kind = 'transcript' AND d.created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM source_chunks c
            JOIN cognitive_source_links l ON l.chunk_id = c.id
            WHERE c.document_id = d.id
          )`,
    ).all(userId, beforeIso) as Array<{ id: string }>;
    if (doomed.length === 0) return { prunedDocs: 0, prunedChunks: 0 };

    const delChunks = this.db.prepare("DELETE FROM source_chunks WHERE document_id = ?");
    const delDoc = this.db.prepare("DELETE FROM source_documents WHERE id = ? AND user_id = ?");
    let prunedChunks = 0;
    for (const { id } of doomed) {
      prunedChunks += Number((delChunks.run(id) as { changes?: number }).changes ?? 0);
      delDoc.run(id, userId);
    }
    return { prunedDocs: doomed.length, prunedChunks };
  }

  /**
   * Insert a source document, or return the existing one with the same
   * (user_id, hash) — re-ingesting identical content is idempotent.
   */
  public createSourceDocument(
    input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): SourceDocument {
    const existing = this.getSourceDocumentByHash(input.userId, input.hash);
    if (existing) return existing;
    const doc: SourceDocument = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      workspaceTag: input.workspaceTag ?? null,
      kind: input.kind,
      uri: input.uri ?? null,
      hash: input.hash,
      title: input.title ?? "",
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata,
    };
    this.db
      .prepare(
        `INSERT INTO source_documents (id, user_id, workspace_tag, kind, uri, hash, title, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.id, doc.userId, doc.workspaceTag, doc.kind, doc.uri, doc.hash, doc.title, doc.createdAt, JSON.stringify(doc.metadata ?? {}));
    return doc;
  }

  /**
   * MEM-30 — look up the document for (user, uri, content-hash), returning its
   * id + stale flag (any state). Lets reindex distinguish "already fresh"
   * (no-op) from "this exact content existed but was staled" (revert → revive)
   * from "brand-new content" (ingest). Newest wins.
   */
  public lookupDocumentByPathHash(userId: string, uri: string, hash: string): { id: string; stale: boolean } | null {
    const row = this.db.prepare(
      `SELECT id, COALESCE(stale, 0) AS stale FROM source_documents
        WHERE user_id = ? AND uri = ? AND hash = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, uri, hash) as any;
    return row ? { id: String(row.id), stale: !!row.stale } : null;
  }

  /**
   * MEM-30 — mark every currently-live document for (user, uri) stale. Returns
   * the count flipped. Used when a file's content drifts: the old index stays
   * for provenance but is excluded from fresh recall.
   */
  public markSourceDocumentsStaleByPath(userId: string, uri: string): number {
    const res = this.db.prepare(
      "UPDATE source_documents SET stale = 1 WHERE user_id = ? AND uri = ? AND COALESCE(stale, 0) = 0",
    ).run(userId, uri);
    return Number((res as any)?.changes ?? 0);
  }

  /** MEM-30 — un-stale a document (revert case: content matches a prior version). */
  public reviveSourceDocument(documentId: string): void {
    this.db.prepare("UPDATE source_documents SET stale = 0 WHERE id = ?").run(documentId);
  }

  /**
   * MEM-28b — resolve an extensionless import target (e.g. `src/parser`) to an
   * indexed, non-stale document, trying common code extensions and `/index.*`.
   * Newest live match wins; null when the imported file isn't indexed.
   */
  public findImportedDocument(userId: string, candidateBase: string): SourceDocument | null {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'];
    const candidates = exts.map((e) => candidateBase + e).concat(exts.map((e) => `${candidateBase}/index${e}`));
    const placeholders = candidates.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT * FROM source_documents WHERE user_id = ? AND COALESCE(stale,0)=0 AND uri IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
    ).get(userId, ...candidates) as any;
    return row ? this.rowToSourceDocument(row) : null;
  }

  /** Append chunks to a document; ordinals continue from the current count. Chunk hash = sha1(content). */
  public addSourceChunks(documentId: string, chunks: SourceChunkInput[]): SourceChunk[] {
    const startOrdinal = ((this.db.prepare("SELECT COUNT(*) AS n FROM source_chunks WHERE document_id = ?").get(documentId) as any)?.n ?? 0) as number;
    // MEM-14 — denormalize the parent doc's scope onto each chunk so chunk-level
    // queries stay scoped without a join.
    const parent = this.db.prepare("SELECT user_id, workspace_tag FROM source_documents WHERE id = ?").get(documentId) as { user_id?: string; workspace_tag?: string } | undefined;
    const stmt = this.db.prepare(
      `INSERT INTO source_chunks (id, document_id, user_id, workspace_tag, ordinal, content, token_count, file_path, symbol, start_line, end_line, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const out: SourceChunk[] = [];
    this.db.exec("BEGIN");
    try {
      chunks.forEach((c, i) => {
        const chunk: SourceChunk = {
          id: randomUUID(),
          documentId,
          ordinal: startOrdinal + i,
          content: c.content,
          tokenCount: c.tokenCount,
          filePath: c.filePath ?? null,
          symbol: c.symbol ?? null,
          startLine: c.startLine ?? null,
          endLine: c.endLine ?? null,
          hash: createHash("sha1").update(c.content).digest("hex"),
        };
        stmt.run(chunk.id, chunk.documentId, parent?.user_id ?? null, parent?.workspace_tag ?? null, chunk.ordinal, chunk.content, chunk.tokenCount, chunk.filePath, chunk.symbol, chunk.startLine, chunk.endLine, chunk.hash);
        out.push(chunk);
      });
      // MEM-28 — record intra-file call/reference edges for this batch's code
      // chunks (those with a symbol). Code files ingest atomically, so `out` is
      // the document's full chunk set here; transcript/doc batches have no
      // symbols and produce no edges.
      const codeChunks = out.filter((c) => c.symbol);
      if (codeChunks.length >= 2) {
        const edges = extractIntraFileCallEdges(codeChunks.map((c) => ({ id: c.id, symbol: c.symbol, content: c.content })));
        if (edges.length > 0) {
          const edgeStmt = this.db.prepare(
            "INSERT OR IGNORE INTO code_symbol_edges (document_id, from_chunk_id, to_chunk_id, kind) VALUES (?, ?, ?, 'calls')",
          );
          for (const e of edges) edgeStmt.run(documentId, e.fromChunkId, e.toChunkId);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return out;
  }

  public getSourceChunk(id: string): SourceChunk | null {
    const row = this.db.prepare("SELECT * FROM source_chunks WHERE id = ?").get(id) as any;
    return row ? this.rowToSourceChunk(row) : null;
  }

  public getSourceChunksByDocument(documentId: string): SourceChunk[] {
    const rows = this.db.prepare("SELECT * FROM source_chunks WHERE document_id = ? ORDER BY ordinal ASC").all(documentId) as any[];
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  /**
   * MEM-29 — resolve a `file:line` seed to the chunk whose [start_line,end_line]
   * span contains the line (the smallest such span wins when chunks nest). Scoped
   * to the caller. Matches file_path by suffix so callers can pass a workspace-
   * relative or absolute path. Returns null when nothing covers the line.
   */
  public getSourceChunkByFileLine(userId: string, filePath: string, line: number): SourceChunk | null {
    const needle = filePath.replace(/^\.\//, "");
    const row = this.db.prepare(
      `SELECT * FROM source_chunks
        WHERE user_id = ?
          AND file_path IS NOT NULL
          AND (file_path = ? OR file_path LIKE ?)
          AND start_line IS NOT NULL AND end_line IS NOT NULL
          AND start_line <= ? AND end_line >= ?
        ORDER BY (end_line - start_line) ASC
        LIMIT 1`,
    ).get(userId, needle, `%${needle}`, line, line) as any;
    return row ? this.rowToSourceChunk(row) : null;
  }

  /**
   * MEM-29 — lexical nearest-neighbour search over the chunk FTS. `query` is a
   * free-text bag of symbols/identifiers (built from a seed chunk); results are
   * ranked by FTS5 `rank` (more negative = better, so ascending). Scoped to the
   * caller; optional excludes/scope let `find_related` drop the seed itself, its
   * own document, and other-language files. `ftsRank` is surfaced so the
   * code-aware reranker (MEM-26/27) can refine ordering.
   */
  public searchSourceChunksFts(
    userId: string,
    query: string,
    limit: number,
    opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
  ): Array<SourceChunk & { ftsRank: number }> {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const cap = Math.max(1, Math.min(200, limit));
    // Over-fetch a little so post-filters (exclude seed/doc, language scope)
    // still leave `limit` candidates for the reranker.
    const fetch = Math.min(200, cap * 4);
    const rows = this.db.prepare(
      `SELECT sc.*, f.rank AS fts_rank
         FROM source_chunks_fts f
         JOIN source_chunks sc ON sc.id = f.chunk_id
         JOIN source_documents d ON d.id = sc.document_id
        WHERE f.user_id = ? AND source_chunks_fts MATCH ? AND COALESCE(d.stale, 0) = 0
        ORDER BY f.rank
        LIMIT ?`,
    ).all(userId, ftsQuery, fetch) as any[];
    const exts = opts?.filePathLike;
    const out: Array<SourceChunk & { ftsRank: number }> = [];
    for (const r of rows) {
      if (opts?.excludeChunkId && r.id === opts.excludeChunkId) continue;
      if (opts?.excludeDocumentId && r.document_id === opts.excludeDocumentId) continue;
      if (exts && exts.length > 0) {
        const fp: string = r.file_path ?? "";
        if (!exts.some((e) => fp.endsWith(e))) continue;
      }
      out.push({ ...this.rowToSourceChunk(r), ftsRank: typeof r.fts_rank === "number" ? r.fts_rank : 0 });
      if (out.length >= cap) break;
    }
    return out;
  }

  /**
   * 0.4.3 — true if any chunk of this document is cited by a live memory's
   * provenance (cognitive_source_links). The source_chunker re-chunk job must
   * skip such docs: re-chunking changes chunk ids and would orphan the links.
   */
  public isSourceDocumentReferenced(documentId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM source_chunks c JOIN cognitive_source_links l ON l.chunk_id = c.id WHERE c.document_id = ? LIMIT 1",
    ).get(documentId);
    return !!row;
  }

  /**
   * 0.4.3 — replace a document's chunks (delete then re-add via addSourceChunks,
   * which restarts ordinals from 0 once the old rows are gone). Used by the
   * source_chunker re-chunk job; callers MUST guard provenance with
   * `isSourceDocumentReferenced` first (FK cascade is declared but not enforced
   * here, so the explicit delete is required).
   */
  public replaceSourceChunks(documentId: string, chunks: SourceChunkInput[]): SourceChunk[] {
    // MEM-28 — clear this document's code edges first. The FK cascade only
    // fires under PRAGMA foreign_keys=ON; mirror the explicit-delete discipline
    // the chunk delete already follows so stale edges can't survive a re-chunk.
    this.db.prepare("DELETE FROM code_symbol_edges WHERE document_id = ?").run(documentId);
    this.db.prepare("DELETE FROM source_chunks WHERE document_id = ?").run(documentId);
    return this.addSourceChunks(documentId, chunks);
  }

  /**
   * MEM-28 — the chunks a chunk directly references (callees) or that reference
   * it (callers), within the same file. Scoped to the caller via the chunk's
   * denormalized user_id. `direction` picks the edge orientation.
   */
  public getCodeEdgeNeighbors(userId: string, chunkId: string, direction: "callees" | "callers"): SourceChunk[] {
    const col = direction === "callees" ? "from_chunk_id" : "to_chunk_id";
    const other = direction === "callees" ? "to_chunk_id" : "from_chunk_id";
    const rows = this.db.prepare(
      `SELECT sc.* FROM code_symbol_edges e
         JOIN source_chunks sc ON sc.id = e.${other}
        WHERE e.${col} = ? AND (sc.user_id = ? OR sc.user_id IS NULL)`,
    ).all(chunkId, userId) as any[];
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  /**
   * MEM-3 — link a cognitive record to the source chunks it was distilled
   * from (batch-level provenance). Idempotent (INSERT OR IGNORE on the
   * (record_id, chunk_id) primary key), so re-extraction doesn't duplicate.
   */
  public linkRecordSources(userId: string, recordId: string, chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO cognitive_source_links (user_id, record_id, chunk_id, created_at) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const chunkId of chunkIds) stmt.run(userId, recordId, chunkId, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * MEM-21 — read-only storage stats for the governance dry-run across the
   * 0.4.3 depth tables. Orphan source chunks = chunks NOT cited by any live
   * memory's provenance (the only ones safe to prune). All user-scoped.
   */
  public getStorageGovernanceStats(userId: string): {
    sourceDocuments: number;
    sourceChunks: { count: number; chars: number; orphanCount: number; orphanChars: number };
    treeNodes: { count: number; chars: number };
    vaultExports: number;
  } {
    const num = (v: any): number => Number(v ?? 0) || 0;
    const docs = this.db.prepare("SELECT COUNT(*) AS n FROM source_documents WHERE user_id = ?").get(userId) as any;
    const chunks = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM source_chunks WHERE user_id = ?")
      .get(userId) as any;
    const orphans = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars
           FROM source_chunks
          WHERE user_id = ?
            AND id NOT IN (SELECT chunk_id FROM cognitive_source_links WHERE user_id = ?)`,
      )
      .get(userId, userId) as any;
    const tree = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(summary_md)), 0) AS chars FROM memory_tree_nodes WHERE user_id = ?")
      .get(userId) as any;
    const vault = this.db.prepare("SELECT COUNT(*) AS n FROM vault_exports WHERE user_id = ?").get(userId) as any;
    return {
      sourceDocuments: num(docs?.n),
      sourceChunks: { count: num(chunks?.n), chars: num(chunks?.chars), orphanCount: num(orphans?.n), orphanChars: num(orphans?.chars) },
      treeNodes: { count: num(tree?.n), chars: num(tree?.chars) },
      vaultExports: num(vault?.n),
    };
  }

  /** MEM-3 — the source chunks a cognitive record cites, ordered by document + position. */
  public getRecordSourceChunks(userId: string, recordId: string): SourceChunk[] {
    const rows = this.db.prepare(
      `SELECT sc.* FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
        WHERE l.record_id = ? AND l.user_id = ?
        ORDER BY sc.document_id ASC, sc.ordinal ASC`,
    ).all(recordId, userId) as any[];
    return rows.map((r) => this.rowToSourceChunk(r));
  }

  /**
   * MEM-ACCURACY (0.4.7) — true when a record's provenance points at a source
   * document that has since been marked `stale` (its file changed / was
   * reindexed after this record was captured). Recall uses this to down-rank +
   * flag "the code this memory was derived from has changed — verify". Returns
   * false for records with no code provenance (pure conversational memories).
   */
  public isRecordSourceStale(userId: string, recordId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM cognitive_source_links l
         JOIN source_chunks sc ON sc.id = l.chunk_id
         JOIN source_documents d ON d.id = sc.document_id
        WHERE l.record_id = ? AND l.user_id = ? AND COALESCE(d.stale, 0) = 1
        LIMIT 1`,
    ).get(recordId, userId);
    return !!row;
  }
}
