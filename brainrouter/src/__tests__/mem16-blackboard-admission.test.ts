import { describe, it, expect, afterEach } from "vitest";
import { MemoryCapturePipeline } from "../memory/capture.js";
import type { BlackboardItem, BlackboardItemInput, CognitiveRecord } from "@kinqs/brainrouter-types";

/**
 * MEM-16 (0.4.4) — blackboard-default admission. Exercises the admission gate
 * (`admitViaBlackboard`) against a minimal in-memory blackboard store: extracted
 * candidates are staged + reconciled, and only the survivors are admitted —
 * duplicates and below-threshold candidates are held on the blackboard, not
 * committed. Fast + deterministic (no sqlite / FTS5).
 */

class FakeBlackboardStore {
  items = new Map<string, BlackboardItem>();
  private n = 0;
  stageBlackboardItems(userId: string, inputs: BlackboardItemInput[]): BlackboardItem[] {
    return inputs.map((inp) => {
      const id = `bb_${this.n++}`;
      const item: BlackboardItem = {
        id,
        userId,
        sourceChunkId: inp.sourceChunkId ?? null,
        candidate: inp.candidate,
        score: inp.score ?? 0,
        status: "pending",
        conflictIds: [],
        // Stable, increasing createdAt so the reconciler's tie-break is deterministic.
        createdAt: `2026-01-01T00:00:${String(this.n).padStart(2, "0")}.000Z`,
        committedRecordId: null,
      };
      this.items.set(id, item);
      return item;
    });
  }
  updateBlackboardItem(
    id: string,
    patch: { status?: BlackboardItem["status"]; conflictIds?: string[]; committedRecordId?: string | null },
  ): void {
    const it = this.items.get(id);
    if (it) Object.assign(it, patch);
  }
}

function pipeline(store: unknown): MemoryCapturePipeline {
  const llm = { run: async () => "" } as any;
  const embed = { isReady: () => false, embed: async () => [] } as any;
  return new MemoryCapturePipeline(store as any, llm, embed);
}

function rec(id: string, content: string, confidence: number): CognitiveRecord {
  return {
    id,
    content,
    type: "codebase_fact",
    priority: 50,
    sceneName: "",
    confidence,
  } as unknown as CognitiveRecord;
}

afterEach(() => {
  delete process.env.BRAINROUTER_BLACKBOARD_ADMISSION;
});

describe("MEM-16 admitViaBlackboard", () => {
  it("admits only survivors: dedups the batch and rejects below-threshold", () => {
    const store = new FakeBlackboardStore();
    const pipe = pipeline(store);
    const records = [
      rec("r1", "The recall pipeline runs four stages", 0.9),
      rec("r2", "the   recall   pipeline runs four stages", 0.5), // dup of r1 (lower score)
      rec("r3", "weak unsupported guess", 0.1), // below 0.3 reject floor
      rec("r4", "Vault export writes a hash ledger", 0.8),
    ];
    const admission = (pipe as any).admitViaBlackboard("u1", records);

    // r1 (winner) + r4 survive; r2 is a duplicate, r3 rejected.
    expect(admission.survivors.map((r: CognitiveRecord) => r.id).sort()).toEqual(["r1", "r4"]);

    const byStatus = (s: string) => [...store.items.values()].filter((i) => i.status === s).length;
    expect(byStatus("reconciled")).toBe(2);
    expect(byStatus("duplicate")).toBe(1);
    expect(byStatus("rejected")).toBe(1);
    expect(store.items.size).toBe(4); // every candidate staged for audit
  });

  it("markCommitted stamps the survivor's blackboard item with the record id", () => {
    const store = new FakeBlackboardStore();
    const pipe = pipeline(store);
    const admission = (pipe as any).admitViaBlackboard("u1", [rec("r1", "A durable fact about chunking", 0.9)]);
    admission.markCommitted("r1");
    const committed = [...store.items.values()].find((i) => i.status === "committed");
    expect(committed?.committedRecordId).toBe("r1");
  });

  it("fails open when admission is disabled (env off) — no staging, all admitted", () => {
    process.env.BRAINROUTER_BLACKBOARD_ADMISSION = "off";
    const store = new FakeBlackboardStore();
    const pipe = pipeline(store);
    const records = [rec("r1", "a", 0.9), rec("r2", "a", 0.9)];
    const admission = (pipe as any).admitViaBlackboard("u1", records);
    expect(admission.survivors).toHaveLength(2);
    expect(store.items.size).toBe(0); // gate skipped entirely
  });

  it("fails open when the store lacks the blackboard capability", () => {
    const pipe = pipeline({}); // no stage/update methods
    const records = [rec("r1", "x", 0.9)];
    const admission = (pipe as any).admitViaBlackboard("u1", records);
    expect(admission.survivors).toHaveLength(1);
  });
});
