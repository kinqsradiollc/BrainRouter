import { describe, it, expect } from "vitest";
import type { RecallResult } from "@kinqs/brainrouter-types";
import { RetrievalService, createRetrievalService, type RecallParams } from "../memory/retrieval/service.js";

describe("RetrievalService", () => {
  it("delegates recall to the wrapped pipeline, passing params through unchanged", async () => {
    const seen: RecallParams[] = [];
    const fakeResult = { memories: [], explanation: undefined } as unknown as RecallResult;
    const svc = new RetrievalService({
      recall: async (params: RecallParams) => {
        seen.push(params);
        return fakeResult;
      },
    });

    const params: RecallParams = { userId: "u1", sessionKey: "s1", query: "where is the recall pipeline" };
    const result = await svc.recall(params);

    expect(result).toBe(fakeResult);
    expect(seen).toEqual([params]);
  });

  it("createRetrievalService builds a RetrievalService over a real pipeline (no work at construction)", () => {
    // The pipeline constructor only stores its deps, so stubs are safe here.
    const svc = createRetrievalService({} as never, {} as never, {} as never);
    expect(svc).toBeInstanceOf(RetrievalService);
    expect(typeof svc.recall).toBe("function");
  });
});
