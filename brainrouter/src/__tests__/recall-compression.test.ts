import { describe, expect, it, vi } from "vitest";
import {
  applyRecallCompression,
  readRecallCompressionConfig,
} from "../memory/compression/recallCompression.js";
import type { RecalledMemory } from "@kinqs/brainrouter-types";

const memories: RecalledMemory[] = [
  { content: "small memory", score: 0.8, type: "fact", recordId: "r1" },
];

describe("recall compression configuration", () => {
  it("defaults to disabled with the documented limits", () => {
    expect(readRecallCompressionConfig({} as NodeJS.ProcessEnv)).toEqual({
      enabled: false,
      minTokens: 500,
      targetKeep: 0.2,
    });
  });

  it("leaves the off-state recalled-memory bytes exactly unchanged", () => {
    const store = { storeCompressionEntry: vi.fn() };
    const result = applyRecallCompression(memories, {
      userId: "u1",
      query: "incident",
      store,
      config: { enabled: false, minTokens: 1, targetKeep: 0.2 },
    });

    expect(result.memories).toBe(memories);
    expect(JSON.stringify(result.memories)).toMatchInlineSnapshot(`"[{\"content\":\"small memory\",\"score\":0.8,\"type\":\"fact\",\"recordId\":\"r1\"}]"`);
    expect(result.compressedCount).toBe(0);
    expect(store.storeCompressionEntry).not.toHaveBeenCalled();
  });

  it("does not compress content below the configured threshold", () => {
    const store = { storeCompressionEntry: vi.fn() };
    const result = applyRecallCompression(memories, {
      userId: "u1",
      query: "incident",
      store,
      config: { enabled: true, minTokens: 100, targetKeep: 0.2 },
    });

    expect(result.memories).toEqual(memories);
    expect(result.compressedCount).toBe(0);
    expect(store.storeCompressionEntry).not.toHaveBeenCalled();
  });

  it("forces the marked lossy branch even when a lossless table would be smaller", () => {
    // Compact homogeneous rows are exactly where the lossless CSV fold would win
    // and be skipped (hash-less, unmarked). Recall must instead take the lossy,
    // CCR-backed branch so the original is offloaded and a marker is emitted.
    const hash = "a".repeat(24);
    const store = { storeCompressionEntry: vi.fn(() => ({ hash })) };
    const jsonArrayMemory: RecalledMemory[] = [
      { content: JSON.stringify(Array.from({ length: 30 }, (_, k) => ({ k }))), score: 0.9, type: "fact", recordId: "rj" },
    ];

    const result = applyRecallCompression(jsonArrayMemory, {
      userId: "u1",
      query: "metrics",
      store,
      config: { enabled: true, minTokens: 1, targetKeep: 0.2 },
    });

    expect(store.storeCompressionEntry).toHaveBeenCalledTimes(1);
    expect(result.compressedCount).toBe(1);
    expect(result.memories[0]?.content).toContain(`<<ccr:${hash}`);
    expect(result.memories[0]?.content).toContain("_ccr_dropped");
  });
});
