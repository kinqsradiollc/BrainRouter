import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMemoryById: vi.fn(),
  markCited: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getMemoryById: mocks.getMemoryById,
    markCited: mocks.markCited,
  },
}));

import { handleMemoryMarkCited } from "./memory_mark_cited.js";

function resultJson(result: Awaited<ReturnType<typeof handleMemoryMarkCited>>) {
  return JSON.parse(String(result.content[0]?.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markCited.mockImplementation(async (
    _userId: string,
    cited: string[],
    all: string[],
  ) => ({
    cited: cited.length,
    nonCited: all.filter((recordId) => !cited.includes(recordId)).length,
    archiveThreshold: 3,
  }));
});

describe("memory_mark_cited learned authority", () => {
  it("keeps ordinary memory citation accounting unchanged", async () => {
    mocks.getMemoryById.mockResolvedValue({ memory: { id: "rec-normal", metadata: {} } });

    const result = await handleMemoryMarkCited({
      citedRecordIds: ["rec-normal"],
      allRecalledRecordIds: ["rec-normal"],
    }, { defaultUserId: "user-a" });

    expect(mocks.markCited).toHaveBeenCalledWith(
      "user-a",
      ["rec-normal"],
      ["rec-normal"],
    );
    expect(resultJson(result)).toMatchObject({ success: true, cited: 1, nonCited: 0 });
  });

  it("removes learned and unclassifiable ids before citation or auto-archive accounting", async () => {
    mocks.getMemoryById.mockImplementation(async (_userId: string, recordId: string) => {
      if (recordId === "rec-learned") {
        return {
          memory: {
            id: recordId,
            metadata: { learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01" } },
          },
        };
      }
      if (recordId === "rec-unclassifiable") throw new Error("store unavailable");
      return { memory: { id: recordId, metadata: {} } };
    });

    const result = await handleMemoryMarkCited({
      citedRecordIds: ["rec-learned", "rec-normal"],
      allRecalledRecordIds: ["rec-learned", "rec-unclassifiable", "rec-normal", "rec-unused"],
    }, { defaultUserId: "user-a" });

    expect(mocks.markCited).toHaveBeenCalledWith(
      "user-a",
      ["rec-normal"],
      ["rec-normal", "rec-unused"],
    );
    expect(resultJson(result)).toMatchObject({ success: true, cited: 1, nonCited: 1 });
  });
});
