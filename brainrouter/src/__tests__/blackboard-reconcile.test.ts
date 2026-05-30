import { describe, it, expect } from "vitest";
import { reconcileBlackboard } from "../memory/blackboard/reconcile.js";
import type { BlackboardItem } from "@kinqs/brainrouter-types";

function item(p: { id: string; content: string; score: number; createdAt?: string }): BlackboardItem {
  return {
    id: p.id, userId: "u1", sourceChunkId: null,
    candidate: { content: p.content, type: "codebase_fact" },
    score: p.score, status: "pending", conflictIds: [],
    createdAt: p.createdAt ?? "2026-05-30T00:00:00Z", committedRecordId: null,
  };
}

describe("reconcileBlackboard (MEM-4)", () => {
  it("dedups by normalized content — highest score wins, rest are duplicates", () => {
    const byId = Object.fromEntries(
      reconcileBlackboard([
        item({ id: "a", content: "The build uses Vite.", score: 0.9 }),
        item({ id: "b", content: "the build  uses vite.", score: 0.5 }), // same normalized content
        item({ id: "c", content: "Tests run with Vitest.", score: 0.8 }),
      ]).map((d) => [d.id, d]),
    );
    expect(byId.a.status).toBe("reconciled");
    expect(byId.a.conflictIds).toEqual(["b"]); // winner absorbed the duplicate
    expect(byId.b.status).toBe("duplicate");
    expect(byId.b.conflictIds).toEqual(["a"]);
    expect(byId.c.status).toBe("reconciled");
  });

  it("rejects candidates below the score threshold", () => {
    expect(reconcileBlackboard([item({ id: "x", content: "weak", score: 0.1 })])[0].status).toBe("rejected");
    expect(reconcileBlackboard([item({ id: "y", content: "weak", score: 0.1 })], { minScore: 0 })[0].status).toBe("reconciled");
  });

  it("tie-break is deterministic — earlier createdAt wins", () => {
    const byId = Object.fromEntries(
      reconcileBlackboard([
        item({ id: "later", content: "same", score: 0.7, createdAt: "2026-05-30T00:00:02Z" }),
        item({ id: "earlier", content: "same", score: 0.7, createdAt: "2026-05-30T00:00:01Z" }),
      ]).map((d) => [d.id, d]),
    );
    expect(byId.earlier.status).toBe("reconciled");
    expect(byId.later.status).toBe("duplicate");
  });
});
