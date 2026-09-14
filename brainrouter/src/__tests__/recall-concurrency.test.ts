/**
 * MEM-PERF — Stage 1 recall starts independent retrieval work concurrently.
 *
 * The test keeps FTS pending while filepath and embedding/vector work start.
 * A serial implementation would wait on FTS first and fail this contract.
 */
import { describe, expect, it } from "vitest";
import type { CognitiveFtsResult } from "@kinqs/brainrouter-types";
import { MemoryRecallPipeline } from "../memory/recall/pipeline.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("MEM-PERF recall Stage 1", () => {
  it("starts filepath and vector retrieval while FTS is still pending", async () => {
    const starts: string[] = [];
    const fts = deferred<CognitiveFtsResult[]>();
    const store = {
      searchCognitiveFts: () => {
        starts.push("fts");
        return fts.promise;
      },
      getMemoriesByFilePath: async () => {
        starts.push("filepath");
        return [];
      },
      searchCognitiveVec: async () => {
        starts.push("vector");
        return [];
      },
    };
    const pipeline = new MemoryRecallPipeline(
      store as never,
      {
        isReady: () => true,
        embed: async () => {
          starts.push("embed");
          return new Float32Array([0.25]);
        },
      } as never,
      { isAvailable: () => false } as never,
    );

    const recall = pipeline.recall({
      userId: "user-1",
      sessionKey: "session-1",
      query: "inspect src/recall/example.ts",
      explain: true,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(expect.arrayContaining(["fts", "filepath", "embed", "vector"]));

    fts.resolve([]);
    await expect(recall).resolves.toMatchObject({ recallStrategy: "hybrid-empty" });
  });
});
