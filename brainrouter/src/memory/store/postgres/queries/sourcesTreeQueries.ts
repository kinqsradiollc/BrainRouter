/**
 * Source documents + chunks, blackboard, memory tree, and vault-export SQL —
 * verbatim extraction from `PostgresMemoryStore`. The private row-mapper helpers
 * are now module-scoped free functions; cross-method calls (e.g.
 * `replaceSourceChunks` → `addSourceChunks`) call the exported functions.
 */

import { randomUUID, createHash } from "node:crypto";
import type {
  SourceDocument,
  SourceChunk,
  SourceChunkInput,
  BlackboardItem,
  BlackboardItemInput,
  BlackboardStatus,
  MemoryTreeNode,
  MemoryTreeNodeInput,
  MemoryTreeKind,
  VaultExportEntry,
  VaultExportInput,
} from "@kinqs/brainrouter-types";
import { asNumber, ftsHasTerms, orTsQuery, pg } from "../converters.js";
import { extractIntraFileCallEdges } from "../../../recall/code-retrieval.js";
import type { Executor } from "./executor.js";

// ── source documents + chunks ───────────────────────────────────────────

function rowToSourceDocument(row: any): SourceDocument {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id ?? null,
    projectId: row.project_id ?? null,
    workspaceTag: row.workspace_tag ?? null,
    projectTag: row.project_tag ?? null,
    kind: row.kind,
    uri: row.uri ?? null,
    hash: row.hash,
    title: row.title ?? "",
    createdAt: row.created_at,
    metadata: row.metadata_json ? (typeof row.metadata_json === "string" ? JSON.parse(row.metadata_json) : row.metadata_json) : {},
  };
}

function rowToSourceChunk(row: any): SourceChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    ordinal: asNumber(row.ordinal),
    content: row.content,
    tokenCount: asNumber(row.token_count),
    filePath: row.file_path ?? null,
    symbol: row.symbol ?? null,
    startLine: row.start_line == null ? null : asNumber(row.start_line),
    endLine: row.end_line == null ? null : asNumber(row.end_line),
    hash: row.hash,
  };
}

export interface SourceDocumentScope {
  orgId?: string | null;
  projectId?: string | null;
  workspaceTag?: string | null;
  projectTag?: string | null;
}

export interface SourceDocumentListFilters {
  orgId?: string;
  projectId?: string;
  workspaceTag?: string;
  /** Surface legacy/local rows only in the owner's default organization. */
  includeUnscoped?: boolean;
}

export async function getSourceDocumentByHash(
  exec: Executor,
  userId: string,
  hash: string,
  scope?: SourceDocumentScope,
): Promise<SourceDocument | null> {
  const row = scope
    ? await exec.one(
      `SELECT * FROM source_documents
        WHERE user_id = $1 AND hash = $2
          AND org_id IS NOT DISTINCT FROM $3
          AND project_id IS NOT DISTINCT FROM $4
          AND workspace_tag IS NOT DISTINCT FROM $5
          AND project_tag IS NOT DISTINCT FROM $6
        LIMIT 1`,
      [userId, hash, scope.orgId ?? null, scope.projectId ?? null, scope.workspaceTag ?? null, scope.projectTag ?? null],
    )
    : await exec.one("SELECT * FROM source_documents WHERE user_id = $1 AND hash = $2 ORDER BY created_at DESC LIMIT 1", [userId, hash]);
  return row ? rowToSourceDocument(row) : null;
}

export async function getSourceDocument(exec: Executor, id: string): Promise<SourceDocument | null> {
  const row = await exec.one("SELECT * FROM source_documents WHERE id = $1", [id]);
  return row ? rowToSourceDocument(row) : null;
}

export async function hasFreshSourceDocument(exec: Executor, userId: string, uri: string): Promise<boolean> {
  const row = await exec.one("SELECT 1 FROM source_documents WHERE user_id = $1 AND uri = $2 AND COALESCE(stale, 0) = 0 LIMIT 1", [userId, uri]);
  return !!row;
}

export async function setSourceDocumentChurn(exec: Executor, documentId: string, commitCount90d: number | null, lastCommitDate: string | null): Promise<void> {
  await exec.run("UPDATE source_documents SET commit_count_90d = $1, last_commit_date = $2 WHERE id = $3", [commitCount90d, lastCommitDate, documentId]);
}

export async function getRecordsMaxChurn(exec: Executor, userId: string, recordIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (recordIds.length === 0) return out;
  const rows = await exec.rows<any>(
    `SELECT l.record_id AS rid, MAX(COALESCE(d.commit_count_90d, 0)) AS churn
       FROM cognitive_source_links l
       JOIN source_chunks sc ON sc.id = l.chunk_id
       JOIN source_documents d ON d.id = sc.document_id
      WHERE l.user_id = $1 AND l.record_id = ANY($2::text[])
      GROUP BY l.record_id
      HAVING MAX(COALESCE(d.commit_count_90d, 0)) > 0`,
    [userId, recordIds],
  );
  for (const r of rows) out.set(String(r.rid), asNumber(r.churn));
  return out;
}

export async function getSourceDocuments(
  exec: Executor,
  userId: string,
  limit = 100,
  filters: SourceDocumentListFilters = {},
): Promise<Array<SourceDocument & { chunkCount: number }>> {
  const clauses = ["d.user_id = $1"];
  const params: unknown[] = [userId];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.orgId) {
    const org = add(filters.orgId);
    clauses.push(filters.includeUnscoped ? `(d.org_id = ${org} OR d.org_id IS NULL)` : `d.org_id = ${org}`);
  }
  if (filters.projectId) clauses.push(`d.project_id = ${add(filters.projectId)}`);
  if (filters.workspaceTag) clauses.push(`d.workspace_tag = ${add(filters.workspaceTag)}`);
  const limitParam = add(limit);
  const rows = await exec.rows<any>(
    `SELECT d.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM source_documents d
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT ${limitParam}`,
    params,
  );
  return rows.map((r) => ({ ...rowToSourceDocument(r), chunkCount: asNumber(r.chunk_count) }));
}

export async function pruneTranscriptSources(exec: Executor, userId: string, beforeIso: string): Promise<{ prunedDocs: number; prunedChunks: number }> {
  return exec.tx(async (client) => {
    const doomed = (await client.query<{ id: string }>(
      `SELECT d.id FROM source_documents d
        WHERE d.user_id = $1 AND d.kind = 'transcript' AND d.created_at < $2
          AND NOT EXISTS (
            SELECT 1 FROM source_chunks c
            JOIN cognitive_source_links l ON l.chunk_id = c.id
            WHERE c.document_id = d.id
          )`,
      [userId, beforeIso],
    )).rows;
    if (doomed.length === 0) return { prunedDocs: 0, prunedChunks: 0 };
    let prunedChunks = 0;
    for (const { id } of doomed) {
      const res = await client.query("DELETE FROM source_chunks WHERE document_id = $1", [id]);
      prunedChunks += res.rowCount ?? 0;
      await client.query("DELETE FROM source_documents WHERE id = $1 AND user_id = $2", [id, userId]);
    }
    return { prunedDocs: doomed.length, prunedChunks };
  });
}

export async function createSourceDocument(exec: Executor, input: Omit<SourceDocument, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<SourceDocument> {
  const existing = await getSourceDocumentByHash(exec, input.userId, input.hash, {
    orgId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    workspaceTag: input.workspaceTag ?? null,
    projectTag: input.projectTag ?? null,
  });
  if (existing) return existing;
  const doc: SourceDocument = {
    id: input.id ?? randomUUID(),
    userId: input.userId,
    orgId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    workspaceTag: input.workspaceTag ?? null,
    projectTag: input.projectTag ?? null,
    kind: input.kind,
    uri: input.uri ?? null,
    hash: input.hash,
    title: input.title ?? "",
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata: input.metadata,
  };
  await exec.run(
    `INSERT INTO source_documents (id, user_id, org_id, project_id, workspace_tag, project_tag, kind, uri, hash, title, created_at, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [doc.id, doc.userId, doc.orgId, doc.projectId, doc.workspaceTag, doc.projectTag ?? null, doc.kind, doc.uri, doc.hash, doc.title, doc.createdAt, JSON.stringify(doc.metadata ?? {})],
  );
  return doc;
}

export async function lookupDocumentByPathHash(exec: Executor, userId: string, uri: string, hash: string): Promise<{ id: string; stale: boolean } | null> {
  const row = await exec.one<any>(
    `SELECT id, COALESCE(stale, 0) AS stale FROM source_documents WHERE user_id = $1 AND uri = $2 AND hash = $3 ORDER BY created_at DESC LIMIT 1`,
    [userId, uri, hash],
  );
  return row ? { id: String(row.id), stale: asNumber(row.stale) !== 0 } : null;
}

export async function markSourceDocumentsStaleByPath(exec: Executor, userId: string, uri: string): Promise<number> {
  return exec.run("UPDATE source_documents SET stale = 1 WHERE user_id = $1 AND uri = $2 AND COALESCE(stale, 0) = 0", [userId, uri]);
}

export async function reviveSourceDocument(exec: Executor, documentId: string): Promise<void> {
  await exec.run("UPDATE source_documents SET stale = 0 WHERE id = $1", [documentId]);
}

export async function findImportedDocument(exec: Executor, userId: string, candidateBase: string): Promise<SourceDocument | null> {
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
  const candidates = exts.map((e) => candidateBase + e).concat(exts.map((e) => `${candidateBase}/index${e}`));
  const row = await exec.one<any>(
    `SELECT * FROM source_documents WHERE user_id = $1 AND COALESCE(stale,0)=0 AND uri = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [userId, candidates],
  );
  return row ? rowToSourceDocument(row) : null;
}

export async function addSourceChunks(exec: Executor, documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
  return exec.tx(async (client) => {
    const startOrdinal = asNumber(
      (await client.query<{ n: string }>("SELECT COUNT(*) AS n FROM source_chunks WHERE document_id = $1", [documentId])).rows[0]?.n,
    );
    const parent = (await client.query<{ user_id?: string; workspace_tag?: string }>(
      "SELECT user_id, workspace_tag FROM source_documents WHERE id = $1", [documentId],
    )).rows[0];
    const out: SourceChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
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
      await client.query(
        `INSERT INTO source_chunks (id, document_id, user_id, workspace_tag, ordinal, content, token_count, file_path, symbol, start_line, end_line, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [chunk.id, chunk.documentId, parent?.user_id ?? null, parent?.workspace_tag ?? null, chunk.ordinal, chunk.content, chunk.tokenCount, chunk.filePath, chunk.symbol, chunk.startLine, chunk.endLine, chunk.hash],
      );
      out.push(chunk);
    }
    const codeChunks = out.filter((c) => c.symbol);
    if (codeChunks.length >= 2) {
      const edges = extractIntraFileCallEdges(codeChunks.map((c) => ({ id: c.id, symbol: c.symbol, content: c.content })));
      for (const e of edges) {
        await client.query(
          "INSERT INTO code_symbol_edges (document_id, from_chunk_id, to_chunk_id, kind) VALUES ($1,$2,$3,'calls') ON CONFLICT DO NOTHING",
          [documentId, e.fromChunkId, e.toChunkId],
        );
      }
    }
    return out;
  });
}

export async function getSourceChunk(exec: Executor, id: string): Promise<SourceChunk | null> {
  const row = await exec.one("SELECT * FROM source_chunks WHERE id = $1", [id]);
  return row ? rowToSourceChunk(row) : null;
}

export async function getSourceChunksByDocument(exec: Executor, documentId: string): Promise<SourceChunk[]> {
  const rows = await exec.rows("SELECT * FROM source_chunks WHERE document_id = $1 ORDER BY ordinal ASC", [documentId]);
  return rows.map((r) => rowToSourceChunk(r));
}

export async function getSourceChunkByFileLine(exec: Executor, userId: string, filePath: string, line: number): Promise<SourceChunk | null> {
  const needle = filePath.replace(/^\.\//, "");
  const row = await exec.one<any>(
    `SELECT * FROM source_chunks
      WHERE user_id = $1 AND file_path IS NOT NULL AND (file_path = $2 OR file_path LIKE $3)
        AND start_line IS NOT NULL AND end_line IS NOT NULL AND start_line <= $4 AND end_line >= $4
      ORDER BY (end_line - start_line) ASC LIMIT 1`,
    [userId, needle, `%${needle}`, line],
  );
  return row ? rowToSourceChunk(row) : null;
}

export async function searchSourceChunksFts(
  exec: Executor,
  userId: string,
  query: string,
  limit: number,
  opts?: { excludeChunkId?: string; excludeDocumentId?: string; filePathLike?: string[] },
): Promise<Array<SourceChunk & { ftsRank: number }>> {
  if (!ftsHasTerms(query)) return [];
  // Code search seeds from a chunk's identifier bag, where ANY shared token is
  // a useful neighbour — match with OR semantics (FTS5 parity), not the AND of
  // `plainto_tsquery`. Without this a camelCase seed (`parseConfig`, stored as
  // the single lexeme `parseconfig`) never matches a split `parse & config`
  // query. `orTsQuery` restricts tokens to `[\p{L}\p{N}_]`, so the body is a
  // safe `to_tsquery` input. `english` config keeps consistency with the
  // generated `content_tsv` column (migration 002) so the GIN index applies.
  const tsq = orTsQuery(query);
  if (!tsq) return [];
  const cap = Math.max(1, Math.min(200, limit));
  const fetch = Math.min(200, cap * 4);
  // Generated content_tsv covers content + symbol (migration 002). Rank with
  // ts_rank; the SQLite path uses FTS5 `rank` ascending — here higher ts_rank
  // is better, and the code reranker (MEM-26/27) refines either way.
  const rows = await exec.rows<any>(
    `SELECT sc.*, ts_rank(sc.content_tsv, to_tsquery('english', $2)) AS fts_rank
       FROM source_chunks sc
       JOIN source_documents d ON d.id = sc.document_id
      WHERE sc.user_id = $1 AND sc.content_tsv @@ to_tsquery('english', $2) AND COALESCE(d.stale, 0) = 0
      ORDER BY fts_rank DESC
      LIMIT $3`,
    [userId, tsq, fetch],
  );
  const exts = opts?.filePathLike;
  const out: Array<SourceChunk & { ftsRank: number }> = [];
  for (const r of rows) {
    if (opts?.excludeChunkId && r.id === opts.excludeChunkId) continue;
    if (opts?.excludeDocumentId && r.document_id === opts.excludeDocumentId) continue;
    if (exts && exts.length > 0) {
      const fp: string = r.file_path ?? "";
      if (!exts.some((e) => fp.endsWith(e))) continue;
    }
    out.push({ ...rowToSourceChunk(r), ftsRank: asNumber(r.fts_rank) });
    if (out.length >= cap) break;
  }
  return out;
}

export async function isSourceDocumentReferenced(exec: Executor, documentId: string): Promise<boolean> {
  const row = await exec.one(
    "SELECT 1 FROM source_chunks c JOIN cognitive_source_links l ON l.chunk_id = c.id WHERE c.document_id = $1 LIMIT 1",
    [documentId],
  );
  return !!row;
}

export async function replaceSourceChunks(exec: Executor, documentId: string, chunks: SourceChunkInput[]): Promise<SourceChunk[]> {
  await exec.tx(async (client) => {
    await client.query("DELETE FROM code_symbol_edges WHERE document_id = $1", [documentId]);
    await client.query("DELETE FROM source_chunks WHERE document_id = $1", [documentId]);
  });
  return addSourceChunks(exec, documentId, chunks);
}

export async function getCodeEdgeNeighbors(exec: Executor, userId: string, chunkId: string, direction: "callees" | "callers"): Promise<SourceChunk[]> {
  const col = direction === "callees" ? "from_chunk_id" : "to_chunk_id";
  const other = direction === "callees" ? "to_chunk_id" : "from_chunk_id";
  const rows = await exec.rows<any>(
    `SELECT sc.* FROM code_symbol_edges e
       JOIN source_chunks sc ON sc.id = e.${other}
      WHERE e.${col} = $1 AND (sc.user_id = $2 OR sc.user_id IS NULL)`,
    [chunkId, userId],
  );
  return rows.map((r) => rowToSourceChunk(r));
}

export async function linkRecordSources(exec: Executor, userId: string, recordId: string, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  const now = new Date().toISOString();
  await exec.tx(async (client) => {
    for (const chunkId of chunkIds) {
      await client.query(
        "INSERT INTO cognitive_source_links (user_id, record_id, chunk_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id, chunk_id) DO NOTHING",
        [userId, recordId, chunkId, now],
      );
    }
  });
}

export async function getStorageGovernanceStats(exec: Executor, userId: string): Promise<{
  sourceDocuments: number;
  sourceChunks: { count: number; chars: number; orphanCount: number; orphanChars: number };
  treeNodes: { count: number; chars: number };
  vaultExports: number;
}> {
  const docs = await exec.one<{ n: string }>("SELECT COUNT(*) AS n FROM source_documents WHERE user_id = $1", [userId]);
  const chunks = await exec.one<{ n: string; chars: string }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM source_chunks WHERE user_id = $1", [userId]);
  const orphans = await exec.one<{ n: string; chars: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars
       FROM source_chunks
      WHERE user_id = $1 AND id NOT IN (SELECT chunk_id FROM cognitive_source_links WHERE user_id = $1)`,
    [userId],
  );
  const tree = await exec.one<{ n: string; chars: string }>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(summary_md)), 0) AS chars FROM memory_tree_nodes WHERE user_id = $1", [userId]);
  const vault = await exec.one<{ n: string }>("SELECT COUNT(*) AS n FROM vault_exports WHERE user_id = $1", [userId]);
  return {
    sourceDocuments: asNumber(docs?.n),
    sourceChunks: { count: asNumber(chunks?.n), chars: asNumber(chunks?.chars), orphanCount: asNumber(orphans?.n), orphanChars: asNumber(orphans?.chars) },
    treeNodes: { count: asNumber(tree?.n), chars: asNumber(tree?.chars) },
    vaultExports: asNumber(vault?.n),
  };
}

export async function getRecordSourceChunks(exec: Executor, userId: string, recordId: string): Promise<SourceChunk[]> {
  const rows = await exec.rows<any>(
    `SELECT sc.* FROM cognitive_source_links l
       JOIN source_chunks sc ON sc.id = l.chunk_id
      WHERE l.record_id = $1 AND l.user_id = $2
      ORDER BY sc.document_id ASC, sc.ordinal ASC`,
    [recordId, userId],
  );
  return rows.map((r) => rowToSourceChunk(r));
}

export async function isRecordSourceStale(exec: Executor, userId: string, recordId: string): Promise<boolean> {
  const row = await exec.one(
    `SELECT 1 FROM cognitive_source_links l
       JOIN source_chunks sc ON sc.id = l.chunk_id
       JOIN source_documents d ON d.id = sc.document_id
      WHERE l.record_id = $1 AND l.user_id = $2 AND COALESCE(d.stale, 0) = 1 LIMIT 1`,
    [recordId, userId],
  );
  return !!row;
}

// ── blackboard ─────────────────────────────────────────────────────────

function rowToBlackboardItem(row: any): BlackboardItem {
  return {
    id: row.id,
    userId: row.user_id,
    sourceChunkId: row.source_chunk_id ?? null,
    candidate: typeof row.candidate_json === "string" ? JSON.parse(row.candidate_json) : row.candidate_json,
    score: asNumber(row.score),
    status: row.status,
    conflictIds: row.conflict_ids_json ? (typeof row.conflict_ids_json === "string" ? JSON.parse(row.conflict_ids_json) : row.conflict_ids_json) : [],
    createdAt: row.created_at,
    committedRecordId: row.committed_record_id ?? null,
  };
}

export async function stageBlackboardItems(exec: Executor, userId: string, items: BlackboardItemInput[]): Promise<BlackboardItem[]> {
  const now = new Date().toISOString();
  const staged: BlackboardItem[] = [];
  await exec.tx(async (client) => {
    for (const input of items) {
      const id = `bb_${randomUUID()}`;
      await client.query(
        `INSERT INTO memory_blackboard_items (id, user_id, source_chunk_id, candidate_json, score, status, conflict_ids_json, created_at, committed_record_id)
         VALUES ($1,$2,$3,$4,$5,'pending','[]',$6,NULL)`,
        [id, userId, input.sourceChunkId ?? null, JSON.stringify(input.candidate), input.score ?? 0, now],
      );
      staged.push({
        id, userId, sourceChunkId: input.sourceChunkId ?? null, candidate: input.candidate,
        score: input.score ?? 0, status: "pending", conflictIds: [], createdAt: now, committedRecordId: null,
      });
    }
  });
  return staged;
}

export async function getBlackboardItem(exec: Executor, id: string): Promise<BlackboardItem | null> {
  const row = await exec.one("SELECT * FROM memory_blackboard_items WHERE id = $1 LIMIT 1", [id]);
  return row ? rowToBlackboardItem(row) : null;
}

export async function getBlackboardItems(exec: Executor, userId: string, status?: BlackboardStatus): Promise<BlackboardItem[]> {
  const rows = status
    ? await exec.rows("SELECT * FROM memory_blackboard_items WHERE user_id = $1 AND status = $2 ORDER BY score DESC, created_at ASC", [userId, status])
    : await exec.rows("SELECT * FROM memory_blackboard_items WHERE user_id = $1 ORDER BY created_at ASC", [userId]);
  return rows.map((r) => rowToBlackboardItem(r));
}

export async function updateBlackboardItem(
  exec: Executor,
  id: string,
  patch: { status?: BlackboardStatus; score?: number; conflictIds?: string[]; committedRecordId?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
  if (patch.score !== undefined) { sets.push("score = ?"); vals.push(patch.score); }
  if (patch.conflictIds !== undefined) { sets.push("conflict_ids_json = ?"); vals.push(JSON.stringify(patch.conflictIds)); }
  if (patch.committedRecordId !== undefined) { sets.push("committed_record_id = ?"); vals.push(patch.committedRecordId); }
  if (sets.length === 0) return;
  vals.push(id);
  await exec.run(pg(`UPDATE memory_blackboard_items SET ${sets.join(", ")} WHERE id = ?`), vals);
}

// ── memory tree ─────────────────────────────────────────────────────────

function rowToTreeNode(row: any): MemoryTreeNode {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    parentId: row.parent_id ?? null,
    level: asNumber(row.level),
    summaryMd: row.summary_md ?? "",
    sourceChunkIds: row.source_chunk_ids_json ? (typeof row.source_chunk_ids_json === "string" ? JSON.parse(row.source_chunk_ids_json) : row.source_chunk_ids_json) : [],
    sealedAt: row.sealed_at ?? null,
    heatScore: asNumber(row.heat_score),
    createdAt: row.created_at,
  };
}

export async function getTreeNodeIdByChunkId(exec: Executor, userId: string, chunkId: string): Promise<string | null> {
  const needle = `%"${chunkId.replace(/[\\%_]/g, (c) => "\\" + c)}"%`;
  // `seq DESC` is the faithful analogue of SQLite's `rowid DESC` tiebreak: on
  // a created_at tie (same-millisecond appends) it deterministically returns
  // the newest covering node rather than an arbitrary heap-ordered row.
  const row = await exec.one<{ id: string }>(
    `SELECT id FROM memory_tree_nodes
      WHERE user_id = $1 AND source_chunk_ids_json LIKE $2 ESCAPE '\\'
      ORDER BY created_at DESC, seq DESC LIMIT 1`,
    [userId, needle],
  );
  return row?.id ?? null;
}

export async function appendTreeNode(exec: Executor, userId: string, input: MemoryTreeNodeInput): Promise<MemoryTreeNode> {
  const node: MemoryTreeNode = {
    id: `tree_${randomUUID()}`,
    userId,
    kind: input.kind,
    parentId: input.parentId ?? null,
    level: input.level ?? 0,
    summaryMd: input.summaryMd,
    sourceChunkIds: input.sourceChunkIds ?? [],
    sealedAt: null,
    heatScore: input.heatScore ?? 0,
    createdAt: new Date().toISOString(),
  };
  await exec.run(
    `INSERT INTO memory_tree_nodes (id, user_id, kind, parent_id, level, summary_md, source_chunk_ids_json, sealed_at, heat_score, created_at, scene_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10)`,
    [node.id, userId, node.kind, node.parentId, node.level, node.summaryMd, JSON.stringify(node.sourceChunkIds), node.heatScore, node.createdAt, input.sceneKey ?? null],
  );
  return node;
}

export async function getDistinctScenes(exec: Executor, userId: string): Promise<Array<{ sceneName: string; recordCount: number }>> {
  const rows = await exec.rows<{ scenename: string; recordcount: string }>(
    `SELECT scene_name AS sceneName, COUNT(*) AS recordCount
       FROM cognitive_records
      WHERE user_id = $1 AND archived = 0 AND scene_name IS NOT NULL AND scene_name != ''
      GROUP BY scene_name
      ORDER BY recordCount DESC`,
    [userId],
  );
  // pg lowercases unquoted output aliases; read either casing safely.
  return rows.map((r: any) => ({ sceneName: r.scenename ?? r.sceneName, recordCount: asNumber(r.recordcount ?? r.recordCount) }));
}

export async function getSceneLeafKeys(exec: Executor, userId: string): Promise<string[]> {
  const rows = await exec.rows<{ scene_key: string }>(
    "SELECT DISTINCT scene_key FROM memory_tree_nodes WHERE user_id = $1 AND scene_key IS NOT NULL",
    [userId],
  );
  return rows.map((r) => r.scene_key);
}

export async function getSceneRecordContents(exec: Executor, userId: string, sceneName: string, limit = 8): Promise<string[]> {
  const rows = await exec.rows<{ content: string }>(
    "SELECT content FROM cognitive_records WHERE user_id = $1 AND scene_name = $2 AND archived = 0 ORDER BY created_time DESC LIMIT $3",
    [userId, sceneName, limit],
  );
  return rows.map((r) => r.content);
}

export async function getUnsealedSceneLeaves(exec: Executor, userId: string, limit = 50): Promise<MemoryTreeNode[]> {
  const rows = await exec.rows<any>(
    `SELECT * FROM memory_tree_nodes
      WHERE user_id = $1 AND scene_key IS NOT NULL AND level = 0 AND sealed_at IS NULL AND parent_id IS NULL
      ORDER BY created_at ASC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => rowToTreeNode(r));
}

export async function getTreeNode(exec: Executor, id: string): Promise<MemoryTreeNode | null> {
  const row = await exec.one("SELECT * FROM memory_tree_nodes WHERE id = $1 LIMIT 1", [id]);
  return row ? rowToTreeNode(row) : null;
}

export async function getTreeChildren(exec: Executor, parentId: string): Promise<MemoryTreeNode[]> {
  const rows = await exec.rows("SELECT * FROM memory_tree_nodes WHERE parent_id = $1 ORDER BY created_at ASC", [parentId]);
  return rows.map((r) => rowToTreeNode(r));
}

export async function getTreeRoots(exec: Executor, userId: string, kind?: MemoryTreeKind): Promise<MemoryTreeNode[]> {
  const rows = kind
    ? await exec.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 AND parent_id IS NULL AND kind = $2 ORDER BY heat_score DESC, created_at ASC", [userId, kind])
    : await exec.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 AND parent_id IS NULL ORDER BY heat_score DESC, created_at ASC", [userId]);
  return rows.map((r) => rowToTreeNode(r));
}

export async function setTreeParent(exec: Executor, childIds: string[], parentId: string): Promise<void> {
  if (childIds.length === 0) return;
  await exec.run("UPDATE memory_tree_nodes SET parent_id = $1 WHERE id = ANY($2::text[])", [parentId, childIds]);
}

export async function sealTreeNode(exec: Executor, id: string): Promise<void> {
  await exec.run("UPDATE memory_tree_nodes SET sealed_at = $1 WHERE id = $2 AND sealed_at IS NULL", [new Date().toISOString(), id]);
}

export async function updateTreeNodeSummary(exec: Executor, id: string, summaryMd: string): Promise<void> {
  await exec.run("UPDATE memory_tree_nodes SET summary_md = $1 WHERE id = $2", [summaryMd, id]);
}

export async function getAllTreeNodes(exec: Executor, userId: string): Promise<MemoryTreeNode[]> {
  const rows = await exec.rows("SELECT * FROM memory_tree_nodes WHERE user_id = $1 ORDER BY level ASC, created_at ASC", [userId]);
  return rows.map((r) => rowToTreeNode(r));
}

// ── vault export ledger ──────────────────────────────────────────────────

export async function upsertVaultExport(exec: Executor, userId: string, input: VaultExportInput): Promise<void> {
  await exec.run(
    `INSERT INTO vault_exports (user_id, path, hash, kind, ref_id, exported_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, path) DO UPDATE SET hash = EXCLUDED.hash, kind = EXCLUDED.kind, ref_id = EXCLUDED.ref_id, exported_at = EXCLUDED.exported_at`,
    [userId, input.path, input.hash, input.kind, input.refId, new Date().toISOString()],
  );
}

export async function getVaultExports(exec: Executor, userId: string): Promise<VaultExportEntry[]> {
  const rows = await exec.rows<any>("SELECT * FROM vault_exports WHERE user_id = $1 ORDER BY path ASC", [userId]);
  return rows.map((r) => ({ userId: r.user_id, path: r.path, hash: r.hash, kind: r.kind, refId: r.ref_id, exportedAt: r.exported_at }));
}
