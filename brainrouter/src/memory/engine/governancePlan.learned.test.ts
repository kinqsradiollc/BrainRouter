import { describe, expect, it, vi } from "vitest";
import { MemoryEngine } from "../engine.js";

describe("generic governance plan learned authority", () => {
  it("makes the public generic memory list ordinary-only even if a caller requests otherwise", async () => {
    const listMemories = vi.fn(async () => []);
    const fakeEngine = { store: { listMemories } } as unknown as MemoryEngine;

    await MemoryEngine.prototype.listMemories.call(
      fakeEngine,
      "user-a",
      { archived: false, excludeLearned: false },
      { limit: 10 },
    );

    expect(listMemories).toHaveBeenCalledWith(
      "user-a",
      { archived: false, excludeLearned: true },
      { limit: 10 },
    );
  });

  it("requests an ordinary-memory-only list before computing counts or sample ids", async () => {
    const listMemories = vi.fn(async () => [{
      recordId: "rec-normal",
      content: "ordinary memory",
      type: "lesson",
      priority: 50,
      sceneName: "",
      skillTag: "",
      createdTime: "2026-08-09T00:00:00.000Z",
      citationCount: 0,
      neverCitedCount: 0,
      archived: false,
    }]);
    const fakeEngine = { store: { listMemories } } as unknown as MemoryEngine;

    const result = await MemoryEngine.prototype.governancePlan.call(fakeEngine, "user-a", {});

    expect(listMemories).toHaveBeenCalledWith("user-a", {
      type: undefined,
      archived: false,
      excludeLearned: true,
    });
    expect(result.sampleRecordIds).toEqual(["rec-normal"]);
  });
});
