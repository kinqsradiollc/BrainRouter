import crypto from "node:crypto";
import { ingestSource, type SourceIngestStore } from "./ingest.js";

/**
 * ADR-015 P2 — ingest a local checkout's files into memory as `file` source docs,
 * scoped by `repoTag` so recall is keyed to the REPO (surviving a moved folder or a
 * second clone), not the local path. This is the "sync" half of repo↔memory: the
 * MATCH (git remote → repoTag) lives in core; here we turn the matched checkout's
 * files into memory.
 *
 * Deliberately store-agnostic and pure over its file list (callers read the files —
 * the desktop via `fsRead`, the CLI via its file tools — and pass them in), so it's
 * unit-testable without a real store or filesystem. Bounded (file count + per-file
 * size) and idempotent (ingestSource dedups by user+hash), so re-running after edits
 * only re-chunks changed files.
 */
export interface RepoFileInput {
  /** repo-relative POSIX path. */
  path: string;
  /** file contents, already read from the local checkout. */
  content: string;
}

export interface IngestRepoOptions {
  userId: string;
  /** Per-repo scope key from the git remote (ADR-015). '' falls back to no scope. */
  repoTag: string;
  /** Skip files larger than this (default 200 KB — matches the desktop fsRead cap). */
  maxBytesPerFile?: number;
  /** Cap files ingested in one pass (default 2000) — bounds cost on big repos. */
  maxFiles?: number;
}

export interface IngestRepoResult {
  ingested: number;
  skipped: number;
  chunks: number;
  /** true when the file cap truncated the input (so callers can surface it). */
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_FILES = 2000;

/** Looks binary: a NUL byte within the first 8 KB (charCodeAt avoids embedding a
 *  literal NUL in source). */
function looksBinary(content: string): boolean {
  const n = Math.min(content.length, 8192);
  for (let i = 0; i < n; i++) if (content.charCodeAt(i) === 0) return true;
  return false;
}

export async function ingestRepoFiles(
  store: SourceIngestStore,
  files: readonly RepoFileInput[],
  opts: IngestRepoOptions,
): Promise<IngestRepoResult> {
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const scope = (opts.repoTag ?? "").trim() || null;
  const capped = files.slice(0, maxFiles);
  let ingested = 0;
  let skipped = 0;
  let chunks = 0;
  for (const f of capped) {
    const content = f.content ?? "";
    if (!content.trim() || Buffer.byteLength(content, "utf8") > maxBytes || looksBinary(content)) {
      skipped++;
      continue;
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const { chunks: c } = await ingestSource(store, {
      userId: opts.userId,
      workspaceTag: scope,
      kind: "file",
      uri: f.path,
      hash,
      title: f.path.split("/").pop() || f.path,
      metadata: { repoTag: opts.repoTag, path: f.path },
    }, content);
    ingested++;
    chunks += c.length;
  }
  return { ingested, skipped, chunks, truncated: files.length > maxFiles };
}
