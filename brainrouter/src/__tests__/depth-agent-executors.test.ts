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
  it("registers the depth agents as on-demand runnable", () => {
    const ids = onDemandRunnableAgentIds();
    for (const id of ["vault_exporter", "blackboard_reconciler", "tree_sealer", "source_chunker", "benchmark_eval", "tree_digest"]) {
      expect(ids, id).toContain(id);
      expect(getJobExecutor(id)).toBeTypeOf("function");
    }
  });

  it("benchmark_eval delegates to engine.runRetrievalBenchmark", async () => {
    let calledWith: { u: string; opts: unknown } | null = null;
    const engine = {
      runRetrievalBenchmark: async (u: string, opts: unknown) => { calledWith = { u, opts }; return { summaryPath: "/b.md", statsByMode: { lexmmr: {} }, sampled: 5, passed: true }; },
    };
    const out = await getJobExecutor("benchmark_eval")!({ userId: "u1", sampleSize: 7 }, ctxWith(engine));
    expect(calledWith).toEqual({ u: "u1", opts: { sampleSize: 7 } });
    expect(out).toMatchObject({ sampled: 5, passed: true });
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

  it("source_chunker re-chunks the given documentIds; no-ops without them", async () => {
    let calledWith: { u: string; ids: string[] } | null = null;
    const engine = {
      rechunkSources: (u: string, ids: string[]) => { calledWith = { u, ids }; return { rechunked: ids.length, skipped: 0, chunksWritten: ids.length * 3 }; },
    };
    const out = await getJobExecutor("source_chunker")!({ userId: "u1", documentIds: ["d1", "d2"] }, ctxWith(engine));
    expect(calledWith).toEqual({ u: "u1", ids: ["d1", "d2"] });
    expect(out).toMatchObject({ rechunked: 2, chunksWritten: 6 });
    const empty = await getJobExecutor("source_chunker")!({ userId: "u1" }, ctxWith(engine));
    expect(empty).toMatchObject({ rechunked: 0, reason: "no documentIds supplied" });
  });

  it("a depth executor without an engine in ctx throws a clear 'not wired' error", async () => {
    await expect(
      getJobExecutor("vault_exporter")!({ userId: "u1" }, { store: {} as never, llmRunner: {} as never }),
    ).rejects.toThrow(/requires an engine/);
  });
});
