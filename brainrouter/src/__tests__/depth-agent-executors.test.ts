import { describe, expect, it } from "vitest";
import { getJobExecutor, onDemandRunnableAgentIds, type JobExecContext } from "../memory/scheduler/executors.js";

/**
 * 0.4.3 (MEM-10) — the three depth agents wired as on-demand executors
 * (runnable via memory_agent_run / the job runner). Thin glue onto engine ops,
 * so these tests assert the glue (call shape + result), using a fake engine.
 */

function ctxWith(engine: unknown): JobExecContext {
  return { store: {} as never, llmRunner: { run: async () => "" } as never, engine: engine as never };
}

describe("depth-agent executors", () => {
  it("registers vault_exporter / blackboard_reconciler / tree_sealer as on-demand runnable", () => {
    const ids = onDemandRunnableAgentIds();
    for (const id of ["vault_exporter", "blackboard_reconciler", "tree_sealer"]) {
      expect(ids, id).toContain(id);
      expect(getJobExecutor(id)).toBeTypeOf("function");
    }
  });

  it("vault_exporter calls engine.exportVault(userId) and returns the ledger summary", async () => {
    let calledUser = "";
    const engine = { exportVault: (u: string) => { calledUser = u; return { dir: "/v", written: 2, unchanged: 5, total: 7 }; } };
    const out = await getJobExecutor("vault_exporter")!({ userId: "u1" }, ctxWith(engine));
    expect(calledUser).toBe("u1");
    expect(out).toMatchObject({ written: 2, unchanged: 5, total: 7 });
  });

  it("blackboard_reconciler reconciles, then commits ONLY the accepted items", async () => {
    const committed: string[] = [];
    const engine = {
      reconcilePendingBlackboard: () => ({
        reconciled: 2, duplicate: 1, rejected: 1,
        items: [
          { id: "a", status: "reconciled" },
          { id: "b", status: "reconciled" },
          { id: "c", status: "duplicate" },
          { id: "d", status: "rejected" },
        ],
      }),
      commitBlackboardItem: (_u: string, id: string) => { committed.push(id); return { committed: true, recordId: `r_${id}` }; },
    };
    const out = await getJobExecutor("blackboard_reconciler")!({ userId: "u1" }, ctxWith(engine));
    expect(committed).toEqual(["a", "b"]); // duplicate/rejected are not committed
    expect(out).toMatchObject({ reconciled: 2, duplicate: 1, rejected: 1, committed: 2 });
  });

  it("tree_sealer summarizes the bucket into a parent; no-ops on empty childIds", async () => {
    const engine = { summarizeBucket: (_u: string, ids: string[]) => ({ id: "tree_parent", n: ids.length }) };
    const out = await getJobExecutor("tree_sealer")!({ userId: "u1", childIds: ["x", "y"] }, ctxWith(engine));
    expect(out).toMatchObject({ parentId: "tree_parent", sealed: 2 });

    const empty = await getJobExecutor("tree_sealer")!({ userId: "u1", childIds: [] }, ctxWith(engine));
    expect(empty).toMatchObject({ parentId: null });
  });

  it("a depth executor without an engine in ctx throws a clear 'not wired' error", async () => {
    await expect(
      getJobExecutor("vault_exporter")!({ userId: "u1" }, { store: {} as never, llmRunner: {} as never }),
    ).rejects.toThrow(/requires an engine/);
  });
});
