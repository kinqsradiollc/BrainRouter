import { describe, expect, it, vi } from "vitest";
import {
  compactCompletedPlannerItems,
  listPlannerBlocksSince,
  tombstonePlannerBlocksForItem,
  withPlannerMutation,
} from "./plannerQueries.js";

function executor() {
  return {
    one: vi.fn(), rows: vi.fn(), run: vi.fn(async () => 1), tx: vi.fn(),
  } as any;
}

describe("planner persistence", () => {
  it("compacts completed payloads with an explicit data-minimisation allowlist", async () => {
    const exec = executor();
    await compactCompletedPlannerItems(exec, "org-1", "user-1", 90);

    const [sql, params] = exec.run.mock.calls[0]!;
    const retainedKeys = [...String(sql).matchAll(/'([^']+)', payload_json->'\1'/g)]
      .map((match) => match[1]);

    // The expression occurs once in SET and once in the no-op guard. Assert
    // the exact allowlist for both, so provenance URLs, notes, blocked state,
    // conflicts, and any future field are minimised by default.
    expect(retainedKeys).toEqual([
      "id", "origin", "title", "completed", "estimateMinutes", "estimateUpdatedAt",
      "id", "origin", "title", "completed", "estimateMinutes", "estimateUpdatedAt",
    ]);
    expect(sql).not.toContain("payload_json -");
    expect(sql).toContain("revision = nextval(pg_get_serial_sequence('planner_items', 'revision'))");
    expect(params).toEqual(["org-1", "user-1", 90]);
  });

  it("pages block sync by its own revision cursor", async () => {
    const exec = executor();
    exec.rows.mockResolvedValue([]);
    await listPlannerBlocksSince(exec, "org-1", "user-1", "42");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("revision > $3");
    expect(sql).toContain("ORDER BY revision ASC");
    expect(sql).toContain("LIMIT 1000");
    expect(sql).toContain("deleted_at_hlc");
    expect(params).toEqual(["org-1", "user-1", "42"]);
  });

  it("locks the exact org/user scope and runs planner reads on the transaction client", async () => {
    const exec = executor();
    const client = {
      query: vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
    };
    exec.tx.mockImplementation(async (fn: (locked: typeof client) => Promise<unknown>) => fn(client));

    await withPlannerMutation(exec, "org-1", "user-1", async (locked) => {
      await locked.getPlannerItem("org-1", "user-1", "item-1");
    });

    expect(exec.tx).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["brainrouter:planner", "org-1", "user-1"])],
    ]);
    expect(client.query.mock.calls[1]?.[0]).toContain("FROM planner_items");
    expect(exec.one).not.toHaveBeenCalled();
  });

  it("rejects a scope change inside a locked planner transaction", async () => {
    const exec = executor();
    const client = {
      query: vi.fn(async (_text: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
    };
    exec.tx.mockImplementation(async (fn: (locked: typeof client) => Promise<unknown>) => fn(client));
    await expect(withPlannerMutation(exec, "org-1", "user-1", (locked) =>
      locked.getPlannerItem("org-2", "user-1", "item-1")))
      .rejects.toThrow(/cannot change organization or user scope/);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("tombstones every child block and advances its pull revision", async () => {
    const exec = executor();
    const deletedAt = { physical: 9_000, logical: 2, deviceId: "device-a" };
    await tombstonePlannerBlocksForItem(exec, "org-1", "user-1", "item-1", deletedAt);
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("deleted_at_hlc = $4::jsonb");
    expect(sql).toContain("updated_at_hlc = $4::jsonb");
    expect(sql).toContain("revision = nextval(pg_get_serial_sequence('planner_blocks', 'revision'))");
    expect(sql).toContain("org_id = $1 AND user_id = $2 AND item_id = $3");
    expect(params).toEqual(["org-1", "user-1", "item-1", JSON.stringify(deletedAt)]);
  });
});
