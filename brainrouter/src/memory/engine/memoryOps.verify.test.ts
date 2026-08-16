import { describe, expect, it, vi } from "vitest";
import type { MemoryEngine } from "../engine.js";
import { getDiagnostics, verifyMemories } from "./memoryOps.js";

function engineWithRecords(records: Array<Record<string, unknown>>) {
  const store = {
    listMemories: vi.fn(async (_userId: string, filters?: { excludeLearned?: boolean }) => (
      filters?.excludeLearned
        ? records.filter((record) => !(
          record.metadata
          && typeof record.metadata === "object"
          && "learned" in record.metadata
        ))
        : records
    )),
    getRecordSourceChunks: vi.fn(async () => [{ filePath: "src/removed.ts" }]),
    isRecordSourceStale: vi.fn(async () => true),
    hasFreshSourceDocument: vi.fn(async () => false),
    archiveCognitiveRecord: vi.fn(async () => undefined),
  };
  return { engine: { store } as unknown as MemoryEngine, store };
}

describe("memory verify learned authority", () => {
  it("still archives an ordinary confirmed-dead anchored record", async () => {
    const { engine, store } = engineWithRecords([{ recordId: "rec-normal", metadata: {} }]);

    const result = await verifyMemories(engine, "user-a", { apply: true });

    expect(result).toMatchObject({ total: 1, archivable: 1, archived: 1 });
    expect(store.listMemories).toHaveBeenCalledWith("user-a", {
      archived: false,
      excludeLearned: true,
    });
    expect(store.archiveCognitiveRecord).toHaveBeenCalledWith("user-a", "rec-normal");
  });

  it("fails closed before inspecting or archiving an explicitly anchored learned record", async () => {
    const { engine, store } = engineWithRecords([{
      recordId: "rec-learned",
      metadata: { learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01" } },
    }]);

    const result = await verifyMemories(engine, "user-a", { apply: true });

    expect(result).toMatchObject({ total: 0, archivable: 0, archived: 0 });
    expect(store.listMemories).toHaveBeenCalledWith("user-a", {
      archived: false,
      excludeLearned: true,
    });
    expect(store.getRecordSourceChunks).not.toHaveBeenCalled();
    expect(store.archiveCognitiveRecord).not.toHaveBeenCalled();
  });
});

describe("memory diagnostics learned authority", () => {
  it("removes learned operation details while retaining ordinary errors", async () => {
    const ordinaryError = {
      id: "op-normal",
      userId: "user-a",
      recordId: "rec-normal",
      operation: "provider_error",
      actor: "system",
      sessionKey: "session-a",
      reason: "provider failed",
      createdAt: "2026-08-09T00:00:00.000Z",
      metadata: {},
    };
    const learnedError = {
      ...ordinaryError,
      id: "op-learned",
      recordId: "rec-learned",
      operation: "learned_item_sync_error",
      reason: "learned sync failed",
      metadata: { itemId: "lrn_0123456789abcdef01" },
    };
    const store = {
      getOperationLog: vi.fn(async () => [learnedError, ordinaryError]),
      getSqliteVersion: vi.fn(async () => "postgres"),
      getMemoryStats: vi.fn(async () => ({
        total: 1,
        archived: 0,
        byType: { lesson: 1 },
        citationRate: 0,
        lastRecallAt: null,
        sensoryTotal: 0,
        sensoryUnextracted: 0,
        focusSceneTotal: 0,
        extraction: { pending: 0, failed: 0 },
      })),
    };

    const result = await getDiagnostics({ store } as unknown as MemoryEngine, "user-a");

    expect(result.recentErrors).toEqual([ordinaryError]);
  });
});
