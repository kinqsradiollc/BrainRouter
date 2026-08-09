import { describe, expect, it, vi } from "vitest";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import type { MemoryEngine } from "../engine.js";
import { updateMemory } from "./memoryOps.js";

function record(metadata: Record<string, unknown>): CognitiveRecord {
  return {
    id: "rec-1",
    userId: "user-a",
    sessionKey: "session-a",
    content: "ordinary memory",
    status: "active",
    confidence: 0.6,
    verificationStatus: "unverified",
    archived: false,
    metadata,
  } as CognitiveRecord;
}

describe("generic update mutation seam learned authority", () => {
  it("refuses a record carrying the reserved learned metadata key", async () => {
    const store = {
      getMemoryById: vi.fn(async () => record({ learned: null })),
      upsertCognitive: vi.fn(),
      insertOperation: vi.fn(),
    };
    const engine = { store, getMemoryById: vi.fn() } as unknown as MemoryEngine;

    await expect(updateMemory(engine, "user-a", "rec-1", { status: "archived" }))
      .resolves.toBeNull();
    expect(store.upsertCognitive).not.toHaveBeenCalled();
    expect(store.insertOperation).not.toHaveBeenCalled();
  });

  it("retains ordinary memory update behavior", async () => {
    const existing = record({});
    const store = {
      getMemoryById: vi.fn(async () => existing),
      upsertCognitive: vi.fn(async () => undefined),
      insertOperation: vi.fn(async () => undefined),
    };
    const getMemoryById = vi.fn(async () => ({ memory: { ...existing, status: "archived" }, evidence: [] }));
    const engine = { store, getMemoryById } as unknown as MemoryEngine;

    const result = await updateMemory(engine, "user-a", "rec-1", {
      status: "archived",
      confidence: 0.8,
    });

    expect(store.upsertCognitive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rec-1", status: "archived", confidence: 0.8, archived: true }),
      { skipAudit: true },
    );
    expect(store.insertOperation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ memory: expect.objectContaining({ status: "archived" }), evidence: [] });
  });
});
