/**
 * ADR-028 D8 — the planner retention sweep has a maintenance caller.
 *
 * `compactCompletedPlannerItems` was written, tested against real Postgres, and
 * invoked by nothing but a two-device script: completed items accumulated for
 * ever, so retention was a claim rather than an operational guarantee. It now
 * runs inside `runRetentionPass`, which `MemoryJobRunner.maybeRunRetention`
 * calls on its own interval.
 *
 * The third test here is the one that matters: remove the planner call from
 * `runRetentionPass` and it fails.
 */
import { describe, expect, it, vi } from "vitest";
import { compactPlannerItems, runRetentionPass } from "./retentionQueries.js";
function executor(planner: Array<{ org_id: string; user_id: string }> = []) {
  return {
    one: vi.fn(async () => ({ folded: 0 })),
    rows: vi.fn(async () => planner),
    run: vi.fn(async () => 3),
    tx: vi.fn(),
  } as any;
}

describe("planner retention", () => {
  it("sweeps each tenant that has expired completed items, and only those", async () => {
    const exec = executor([
      { org_id: "org-1", user_id: "user-1" },
      { org_id: "org-2", user_id: "user-7" },
    ]);

    const compacted = await compactPlannerItems(exec, { retentionDays: 90, batchSize: 500 });

    const [listSql, listParams] = exec.rows.mock.calls[0]!;
    expect(listSql).toContain("SELECT DISTINCT org_id, user_id");
    expect(listSql).toContain("completed = true");
    // Bounded per pass, like every other retention statement here.
    expect(listSql).toContain("LIMIT $2::int");
    expect(listParams).toEqual([90, 500]);

    // Per-(org,user), because the planner's user is part of the KEY. A global
    // UPDATE would be a second statement drifting from the one the sync path
    // already proves the shape of.
    expect(exec.run.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      ["org-1", "user-1", 90],
      ["org-2", "user-7", 90],
    ]);
    expect(compacted).toBe(6);
  });

  it("does nothing at all when no tenant has expired items", async () => {
    const exec = executor([]);
    expect(await compactPlannerItems(exec)).toBe(0);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("is part of the scheduled retention pass, and reported in its result", async () => {
    const exec = executor([{ org_id: "org-1", user_id: "user-1" }]);
    const result = await runRetentionPass(exec, { retentionDays: 90 });

    expect(result.plannerItemsCompacted).toBe(3);
    expect(
      exec.run.mock.calls.some(([sql]: [string]) => String(sql).includes("UPDATE planner_items")),
    ).toBe(true);
  });

  it("a failing planner sweep is reported, never propagated into the job drain", async () => {
    const exec = executor([{ org_id: "org-1", user_id: "user-1" }]);
    exec.rows.mockRejectedValueOnce(new Error("planner_items is being migrated"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runRetentionPass(exec);

    expect(result.plannerItemsCompacted).toBe(0);
    expect(logged).toHaveBeenCalledWith(
      "[BrainRouter] planner compaction failed:",
      "planner_items is being migrated",
    );
    logged.mockRestore();
  });
});
