import { describe, expect, it, vi } from "vitest";
import { createTrackItem, deleteTrackItem, listTrackItems, transitionTrackItem, getTrackItemBySourceRef } from "./trackQueries.js";

const sampleRow = {
  id: "wi_1", org_id: "org-1", user_id: "user-1", title: "Ship it", description: "",
  type: "task", status: "todo", status_category: "todo", priority: "medium",
  assignee: null, labels_json: '["ui","p1"]', source: "manual", source_ref: null,
  completed_at: null, archived_at: null,
  created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z",
};

function executor(row: Record<string, unknown> | null = sampleRow) {
  return { one: vi.fn(async () => row), rows: vi.fn(async () => (row ? [row] : [])), run: vi.fn(async () => 1), tx: vi.fn() } as any;
}

describe("track queries — tenancy + semantics", () => {
  it("lists an org's items, hides archived by default, and is org-scoped", async () => {
    const exec = executor();
    await listTrackItems(exec, "org-1");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("archived_at IS NULL");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(params[0]).toBe("org-1");
  });

  it("includes archived only when asked", async () => {
    const exec = executor();
    await listTrackItems(exec, "org-1", { includeArchived: true });
    const [sql] = exec.rows.mock.calls[0]!;
    expect(sql).not.toContain("archived_at IS NULL");
  });

  it("creating a completed item stamps completed_at; parses labels on read", async () => {
    const exec = executor();
    const item = await createTrackItem(exec, { id: "wi_1", orgId: "org-1", userId: "user-1", title: "Ship it", statusCategory: "completed" });
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO track_items");
    // completed_at (last param) is set for a completed item.
    expect(params[params.length - 1]).not.toBeNull();
    expect(item.labels).toEqual(["ui", "p1"]);
  });

  it("transition sets completed_at via bucket and is org-scoped", async () => {
    const exec = executor();
    await transitionTrackItem(exec, "org-1", "wi_1", "done", "completed");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("WHERE org_id = $1 AND id = $2");
    expect(sql).toContain("completed_at = CASE WHEN $4 = 'completed'");
    expect(params).toEqual(["org-1", "wi_1", "done", "completed"]);
  });

  it("delete is org-scoped (no cross-org deletes)", async () => {
    const exec = executor();
    await deleteTrackItem(exec, "org-1", "wi_1");
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM track_items WHERE org_id = $1 AND id = $2");
    expect(params).toEqual(["org-1", "wi_1"]);
  });

  it("source-ref lookup is org-scoped", async () => {
    const exec = executor(null);
    await getTrackItemBySourceRef(exec, "org-1", "meeting-9:action-2");
    const [sql, params] = exec.one.mock.calls[0]!;
    expect(sql).toContain("org_id = $1 AND source_ref = $2");
    expect(params).toEqual(["org-1", "meeting-9:action-2"]);
  });
});
