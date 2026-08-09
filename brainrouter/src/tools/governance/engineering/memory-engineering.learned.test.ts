import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMemoryById: vi.fn(),
  updateMemory: vi.fn(),
  getRecordProvenance: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    getMemoryById: mocks.getMemoryById,
    updateMemory: mocks.updateMemory,
    getRecordProvenance: mocks.getRecordProvenance,
  },
}));

import { handleMemoryEngineeringTool } from "./memory-engineering.js";

function resultJson(result: Awaited<ReturnType<typeof handleMemoryEngineeringTool>>) {
  return JSON.parse(String(result.content[0]?.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecordProvenance.mockResolvedValue([{ chunkId: "chunk-1" }]);
});

describe("memory_verify learned authority", () => {
  it("keeps ordinary verification inspection and mutation available", async () => {
    const ordinary = { memory: { id: "rec-normal", metadata: {} }, evidence: [] };
    const updated = { memory: { id: "rec-normal", confidence: 0.9, metadata: {} }, evidence: [] };
    mocks.getMemoryById.mockResolvedValue(ordinary);
    mocks.updateMemory.mockResolvedValue(updated);

    const result = await handleMemoryEngineeringTool("memory_verify", {
      recordId: "rec-normal",
      confidence: 0.9,
    }, { defaultUserId: "user-a" });

    expect(mocks.updateMemory).toHaveBeenCalledWith("user-a", "rec-normal", {
      confidence: 0.9,
      status: undefined,
      verificationStatus: undefined,
      note: undefined,
    });
    expect(mocks.getRecordProvenance).toHaveBeenCalledWith("user-a", "rec-normal");
    expect(resultJson(result)).toEqual({ record: updated, sources: [{ chunkId: "chunk-1" }] });
  });

  it("fails closed on any reserved learned metadata before read or mutation output", async () => {
    mocks.getMemoryById.mockResolvedValue({
      memory: { id: "rec-learned", metadata: { learned: null } },
      evidence: [],
    });

    await expect(handleMemoryEngineeringTool("memory_verify", {
      recordId: "rec-learned",
      status: "archived",
    }, { defaultUserId: "user-a" })).rejects.toThrow(/unavailable for learned memory records/);

    expect(mocks.updateMemory).not.toHaveBeenCalled();
    expect(mocks.getRecordProvenance).not.toHaveBeenCalled();
  });
});
