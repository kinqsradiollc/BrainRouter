import { beforeEach, describe, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({
  store: {
    storeCompressionEntry: vi.fn(),
    retrieveCompressionEntry: vi.fn(),
    getCompressionStats: vi.fn(),
  },
}));

vi.mock("../memory/engine.js", () => ({ memoryEngine: { store } }));

import {
  handleMemoryCompress,
  memoryCompressToolSchema,
} from "../tools/working/memory_compress.js";
import {
  handleMemoryRetrieve,
  memoryRetrieveToolSchema,
} from "../tools/recall/memory_retrieve.js";
import {
  handleMemoryStats,
  memoryStatsToolSchema,
} from "../tools/working/memory_stats.js";

function parseToolText<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0]!.text);
}

describe("memory compression tools", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    store.storeCompressionEntry.mockReturnValue({ hash: "0123456789abcdef01234567" });
  });

  it("compresses content and returns a reversible reference under the request user", async () => {
    const content = JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id, message: `record ${id} with useful context` })));
    const result = await handleMemoryCompress({ content }, { defaultUserId: "tenant-a" });
    const payload = parseToolText<{ hash: string; kind: string; compressed: string }>(result);

    expect(store.storeCompressionEntry).toHaveBeenCalledWith(expect.objectContaining({ userId: "tenant-a", originalContent: content }));
    expect(payload.hash).toBe("0123456789abcdef01234567");
    expect(payload.kind).toBe("json");
    expect(payload.compressed).toContain("_ccr_dropped");
  });

  it("returns full originals, filtered subsets, and friendly missing-reference errors", async () => {
    store.retrieveCompressionEntry.mockReturnValueOnce({
      kind: "full",
      entry: { hash: "0123456789abcdef01234567" },
      originalContent: "full source",
    });
    const full = await handleMemoryRetrieve({ hash: "0123456789abcdef01234567" }, { defaultUserId: "tenant-a" });
    expect(parseToolText<{ original_content: string }>(full).original_content).toBe("full source");
    expect(store.retrieveCompressionEntry).toHaveBeenLastCalledWith("tenant-a", "0123456789abcdef01234567", undefined);

    store.retrieveCompressionEntry.mockReturnValueOnce({
      kind: "subset",
      entry: { hash: "0123456789abcdef01234567" },
      results: [{ id: 2 }],
    });
    const subset = await handleMemoryRetrieve({ hash: "0123456789abcdef01234567", query: "database" }, { defaultUserId: "tenant-a" });
    expect(parseToolText<{ count: number; results: unknown[] }>(subset)).toEqual({
      hash: "0123456789abcdef01234567",
      query: "database",
      results: [{ id: 2 }],
      count: 1,
    });

    const invalid = await handleMemoryRetrieve({ hash: "bad" }, { defaultUserId: "tenant-a" });
    expect(parseToolText<{ error: string; hint: string }>(invalid)).toMatchObject({ error: expect.any(String), hint: expect.any(String) });
  });

  it("reports user-scoped compression statistics", async () => {
    store.getCompressionStats.mockReturnValue({
      compressions: 2,
      retrievals: 3,
      totalTokensSaved: 1_200,
      savingsPercent: 68,
      estimatedCostSavedUsd: 0.0036,
      recentEvents: [],
      store: { entries: 2, maxEntries: 1_000 },
    });

    const result = await handleMemoryStats({}, { defaultUserId: "tenant-a" });
    expect(store.getCompressionStats).toHaveBeenCalledWith("tenant-a");
    expect(parseToolText<{ total_tokens_saved: number; store: { entries: number } }>(result)).toMatchObject({
      total_tokens_saved: 1_200,
      store: { entries: 2 },
    });
  });

  it("declares the three MCP tool schemas", () => {
    expect(memoryCompressToolSchema.name).toBe("memory_compress");
    expect(memoryRetrieveToolSchema.name).toBe("memory_retrieve");
    expect(memoryStatsToolSchema.name).toBe("memory_stats");
  });
});
