import { describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor.js";
import { getMemoryStats, listMemories } from "./userStatsQueries.js";

describe("generic list and stats learned boundary", () => {
  it("adds an explicit learned exclusion to the generic list query when requested", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    await listMemories(
      { rows } as unknown as Executor,
      "user-a",
      { archived: false, excludeLearned: true },
      { limit: 25 },
    );

    expect(rows.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
  });

  it("excludes learned rows from every cognitive aggregate used by generic stats and diagnostics", async () => {
    const one = vi.fn(async (sql: string) => {
      if (sql.includes("MAX(recorded_at)")) return { c: "0", last_at: null };
      return { c: "0", cited: "0", total: "0" };
    });
    const rows = vi.fn(async (_sql: string, _params?: unknown[]) => []);
    const exec = { one, rows } as unknown as Executor;

    await getMemoryStats(exec, "user-a");

    const cognitiveSql = [
      ...one.mock.calls.map((call) => String(call[0])),
      ...rows.mock.calls.map((call) => String(call[0])),
    ].filter((sql) => sql.includes("cognitive_records"));
    expect(cognitiveSql).toHaveLength(4);
    for (const sql of cognitiveSql) {
      expect(sql).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    }
  });
});
