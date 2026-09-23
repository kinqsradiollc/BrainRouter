/**
 * ADR-015 P2/P3 — bounded, idempotent ingest of a local checkout's files into
 * memory, scoped by REPO identity (repoTag) so recall is keyed to the repo and
 * survives a moved/renamed folder or a second clone.
 *
 * This is the production caller for `ingestRepoFiles`. The desktop "Index this
 * repo into memory" action (host `action:index-repo`) walks the git-aware file
 * list, reads each file from the LOCAL checkout (D2 — no auth for file content),
 * and sends `{path, content}` here; the server hashes, dedups, skips
 * binary/empty/oversized files, and scopes every chunk by `repoTag`. Opt-in and
 * bounded end to end (file count + per-file size caps).
 */
import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";
import { ingestRepoFiles } from "../../memory/source/ingestRepo.js";
import type { SourceIngestStore } from "../../memory/source/ingest.js";

// Hard transport bounds (defence in depth on top of ingestRepoFiles' own caps):
// a single call carries at most 3000 files, each ≤400 KB of text. Oversized
// files are dropped by ingestRepoFiles (200 KB default) rather than rejected.
const MAX_FILES = 3000;
const MAX_CONTENT_CHARS = 400_000;

export const memoryIngestRepoToolSchema = {
  name: "memory_ingest_repo",
  description:
    "ADR-015 — index a local checkout's files into memory, scoped by repo identity (repoTag) so recall survives a moved/renamed folder or a second clone. Files are read client-side from the local checkout and sent as {path, content}; the server dedups by content hash and skips binary/empty/oversized files. Opt-in and bounded. Returns {ingested, skipped, chunks, truncated}.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "The ID of the user (enforces multi-tenant isolation)."
      },
      repoTag: {
        type: "string",
        description: "The 16-hex repo-identity tag (from git-info). Scopes the ingested files by REPO; omit for an unscoped ingest."
      },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Repo-relative POSIX path." },
            content: { type: "string", description: "File contents, read from the local checkout." }
          },
          required: ["path", "content"]
        },
        description: "The checkout's files to index. Binary/empty/oversized entries are skipped server-side."
      },
      maxFiles: { type: "number", description: "Cap files ingested in one pass (default 2000)." },
      maxBytesPerFile: { type: "number", description: "Skip files larger than this (default 200 KB)." }
    },
    required: ["files"]
  }
} as const;

export async function handleMemoryIngestRepo(
  args: any,
  options?: { defaultUserId?: string },
) {
  const params = z.object({
    userId: z.string().optional(),
    repoTag: z.string().trim().max(64).optional(),
    files: z.array(z.object({
      path: z.string().trim().min(1).max(1024),
      content: z.string().max(MAX_CONTENT_CHARS),
    })).max(MAX_FILES),
    maxFiles: z.number().int().positive().max(MAX_FILES).optional(),
    maxBytesPerFile: z.number().int().positive().optional(),
  }).parse(args);
  const userId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    const result = await ingestRepoFiles(
      memoryEngine.store as unknown as SourceIngestStore,
      params.files,
      {
        userId,
        repoTag: params.repoTag ?? "",
        ...(params.maxFiles ? { maxFiles: params.maxFiles } : {}),
        ...(params.maxBytesPerFile ? { maxBytesPerFile: params.maxBytesPerFile } : {}),
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    return { isError: true, content: [{ type: "text", text: `Repo ingest failed: ${err.message}` }] };
  }
}
