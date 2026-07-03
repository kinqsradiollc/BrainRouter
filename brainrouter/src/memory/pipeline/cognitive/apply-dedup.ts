/**
 * AUG-A2 (0.4.1) — apply-time memory dedup.
 *
 * The LLM/embedding dedup pass (`deduplicateMemories`) runs before store
 * writes, but it can still let exact or near-exact duplicates through. This
 * is a cheap, deterministic guard applied as records are about to land:
 *
 *   off    — never drop (default; zero behaviour change)
 *   strict — drop a record whose content hash exactly matches one already kept
 *   fuzzy  — also drop when cosine similarity to a kept record ≥ threshold
 *
 * Pure (no I/O) so the decision logic unit-tests cleanly. The mode is read
 * from `BRAINROUTER_DEDUP_MODE` (brain-side env, like the engine's other
 * knobs); default `off` keeps the pipeline exactly as it was.
 */

import { createHash } from "node:crypto";

export type DedupMode = "off" | "strict" | "fuzzy";

export function resolveDedupMode(env: NodeJS.ProcessEnv = process.env): DedupMode {
  const raw = env.BRAINROUTER_DEDUP_MODE?.trim().toLowerCase();
  return raw === "strict" || raw === "fuzzy" ? raw : "off";
}

/** Stable content hash (16-hex SHA-256 prefix) over the trimmed, ws-collapsed text. */
export function contentHash(content: string): string {
  const normalized = (content ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function cosineSim(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const DEFAULT_FUZZY_THRESHOLD = 0.97;

export interface DedupCandidate {
  hash: string;
  embedding?: Float32Array | number[];
}

/**
 * Decide whether a new record duplicates one already kept this batch.
 * `off` always returns false. `strict` matches on content hash. `fuzzy`
 * additionally matches when cosine ≥ threshold (needs embeddings on both
 * sides — falls back to the hash check when embeddings are absent).
 */
export function isDuplicate(
  mode: DedupMode,
  candidate: DedupCandidate,
  kept: DedupCandidate[],
  threshold = DEFAULT_FUZZY_THRESHOLD,
): boolean {
  if (mode === "off") return false;
  for (const k of kept) {
    if (k.hash === candidate.hash) return true;
    if (mode === "fuzzy" && candidate.embedding && k.embedding) {
      if (cosineSim(candidate.embedding, k.embedding) >= threshold) return true;
    }
  }
  return false;
}
