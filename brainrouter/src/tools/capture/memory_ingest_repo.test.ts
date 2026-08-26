/**
 * ADR-015 P2/P3 — memory_ingest_repo routes a checkout's files into the repo
 * ingest path (ingestRepoFiles), scoped by repoTag, with server-authoritative
 * userId and bounded input.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const { ingestRepoFiles } = vi.hoisted(() => ({
  ingestRepoFiles: vi.fn(async (_store: unknown, _files: unknown, _opts: { userId: string; repoTag: string }) =>
    ({ ingested: 2, skipped: 1, chunks: 5, truncated: false })),
}));
vi.mock("../../memory/engine.js", () => ({ memoryEngine: { store: {} } }));
vi.mock("../../memory/source/ingestRepo.js", () => ({ ingestRepoFiles }));

import { handleMemoryIngestRepo } from "./memory_ingest_repo.js";

afterEach(() => { ingestRepoFiles.mockClear(); });

describe("memory_ingest_repo (ADR-015 P2/P3)", () => {
  it("passes files + repoTag + resolved userId to ingestRepoFiles", async () => {
    const res = await handleMemoryIngestRepo(
      { repoTag: "feedfacecafebabe", files: [{ path: "a.ts", content: "x" }, { path: "b.ts", content: "y" }] },
      { defaultUserId: "u1" },
    );
    expect(ingestRepoFiles).toHaveBeenCalledOnce();
    const [, files, opts] = ingestRepoFiles.mock.calls[0]!;
    expect(files).toEqual([{ path: "a.ts", content: "x" }, { path: "b.ts", content: "y" }]);
    expect(opts.repoTag).toBe("feedfacecafebabe");
    expect(opts.userId).toBe("u1");
    expect(JSON.parse((res as any).content[0].text)).toMatchObject({ ingested: 2, skipped: 1, chunks: 5 });
  });

  it("defaults repoTag to '' (unscoped) when absent, userId to 'default'", async () => {
    await handleMemoryIngestRepo({ files: [{ path: "a", content: "x" }] });
    const opts = ingestRepoFiles.mock.calls[0]![2];
    expect(opts.repoTag).toBe("");
    expect(opts.userId).toBe("default");
  });

  it("rejects a payload over the 3000-file transport cap without ingesting", async () => {
    const files = Array.from({ length: 3001 }, (_, i) => ({ path: `f${i}`, content: "x" }));
    await expect(handleMemoryIngestRepo({ files })).rejects.toThrow();
    expect(ingestRepoFiles).not.toHaveBeenCalled();
  });
});
