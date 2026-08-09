import { describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor.js";
import { exportMemories, getOperationLog } from "./operationsQueries.js";

describe("generic operation and export learned boundary", () => {
  it("excludes learned operations and operations linked to learned records", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    await getOperationLog(
      { rows } as unknown as Executor,
      "user-a",
      { limit: 25 },
    );

    const sql = rows.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("operation NOT LIKE 'learned_item_%'");
    expect(sql).toContain("metadata_json::jsonb -> 'itemId' IS NULL");
    expect(sql).toContain("cr.metadata_json::jsonb -> 'learned' IS NOT NULL");
  });

  it("excludes learned records plus their evidence and operations from store-level export", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    await exportMemories({ rows } as unknown as Executor, "user-a");

    expect(rows).toHaveBeenCalledTimes(3);
    const [memorySql, evidenceSql, operationSql] = rows.mock.calls.map((call) => call[0]);
    expect(memorySql).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    expect(evidenceSql).toContain("cr.metadata_json::jsonb -> 'learned' IS NOT NULL");
    expect(operationSql).toContain("operation NOT LIKE 'learned_item_%'");
    expect(operationSql).toContain("cr.metadata_json::jsonb -> 'learned' IS NOT NULL");
  });
});
