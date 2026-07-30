// MEM-CHUNK (0.4.14) — split over-long imported memories into chunk records so
// the recall stages operate on focused units instead of one long blob. Without
// this, a ~2,600-token session stored as a single cognitive record breaks the
// value-add stages: the reranker truncates docs to 700 chars (~7% of it), and
// one embedding over the whole session is a blurry average. Chunking restores
// both (benchmarked under MEM-EVAL).
//
// Behaviour-preserving for normal-length records (content ≤ threshold → returned
// unchanged). Parent provenance is kept in metadata + encoded in the child id
// (`${parentId}::c${i}`) so callers can roll a chunk back to its source.

/** Default char budget per chunk (~375 tokens — comfortably under the reranker's
 *  700-char window). 0 disables chunking. */
export const IMPORT_CHUNK_DEFAULT_CHARS = 1500;

export function readImportChunkChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BRAINROUTER_IMPORT_CHUNK_CHARS;
  if (raw === undefined || raw.trim() === "") return IMPORT_CHUNK_DEFAULT_CHARS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : IMPORT_CHUNK_DEFAULT_CHARS;
}

/** Split `content` into ≤`maxChars` windows with a small overlap so a fact that
 *  straddles a boundary still appears whole in one chunk. */
export function chunkContent(content: string, maxChars: number, overlap = 100): string[] {
  if (maxChars <= 0 || content.length <= maxChars) return [content];
  const step = Math.max(1, maxChars - Math.min(overlap, maxChars - 1));
  const chunks: string[] = [];
  for (let start = 0; start < content.length; start += step) {
    chunks.push(content.slice(start, start + maxChars));
    if (start + maxChars >= content.length) break;
  }
  return chunks;
}

/** Strip the `::c{i}` suffix to recover a chunk record's parent id (id-safe:
 *  returns the input unchanged when it isn't a chunk id). */
export function chunkParentId(recordId: string): string {
  const m = /^(.*)::c\d+$/.exec(recordId);
  return m ? m[1] : recordId;
}

interface ChunkableRecord {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Expand one import record into chunk records when its content exceeds
 *  `maxChars`; otherwise return it unchanged. Pure. */
export function expandImportRecord<T extends ChunkableRecord>(record: T, maxChars: number): T[] {
  const content = record.content ?? "";
  if (maxChars <= 0 || content.length <= maxChars) return [record];
  const parts = chunkContent(content, maxChars);
  if (parts.length <= 1) return [record];
  return parts.map((chunk, i) => ({
    ...record,
    id: `${record.id}::c${i}`,
    content: chunk,
    metadata: { ...(record.metadata ?? {}), parentRecordId: record.id, chunkIndex: i, chunkCount: parts.length },
  }));
}
