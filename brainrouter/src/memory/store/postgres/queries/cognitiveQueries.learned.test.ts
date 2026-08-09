import { describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor.js";
import {
  archiveCognitiveRecord,
  incrementNeverCited,
  invalidateCognitiveRecord,
  listLessonsForHygiene,
  markCited,
  promoteDurableMemories,
  updateCognitiveConfidence,
} from "./cognitiveQueries.js";

describe("generic citation SQL learned boundary", () => {
  it("excludes any record carrying learned metadata from cited updates", async () => {
    const run = vi.fn(async (_sql: string, _params: unknown[]) => undefined);
    await markCited({ run } as unknown as Executor, "user-a", ["rec-1"]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
  });

  it("excludes learned records from never-cited updates and returned archive candidates", async () => {
    const run = vi.fn(async (_sql: string, _params: unknown[]) => undefined);
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => (
      [{ record_id: "rec-normal", never_cited_count: 2 }]
    ));
    const result = await incrementNeverCited(
      { run, rows } as unknown as Executor,
      "user-a",
      ["rec-normal", "rec-learned"],
    );

    expect(run.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    expect(rows.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    expect(result).toEqual([{ recordId: "rec-normal", neverCitedCount: 2 }]);
  });

  it("makes the generic archive primitive itself refuse learned records", async () => {
    const run = vi.fn(async (_sql: string, _params: unknown[]) => undefined);
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    await archiveCognitiveRecord({ run, rows } as unknown as Executor, "user-a", "rec-1");

    expect(rows.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    expect(run).not.toHaveBeenCalled();
  });

  it("excludes learned projections from lesson-hygiene candidate selection", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    await listLessonsForHygiene({ rows } as unknown as Executor, "user-a", 100);

    expect(rows.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
  });

  it("atomically refuses generic supersede and confidence mutations for learned rows", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => []);
    const run = vi.fn(async (_sql: string, _params: unknown[]) => undefined);
    const exec = { rows, run } as unknown as Executor;

    await invalidateCognitiveRecord(exec, "user-a", "rec-learned", "rec-new");
    await updateCognitiveConfidence(exec, "user-a", "rec-learned", 0.2, "archived");

    expect(rows).toHaveBeenCalledTimes(2);
    for (const [sql] of rows.mock.calls) {
      expect(sql).toContain("metadata_json::jsonb -> 'learned' IS NULL");
      expect(sql).toContain("RETURNING record_id");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("retains ordinary supersede and confidence mutations and their audit events", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => [{ record_id: "rec-normal" }]);
    const run = vi.fn(async (_sql: string, _params: unknown[]) => undefined);
    const exec = { rows, run } as unknown as Executor;

    await invalidateCognitiveRecord(exec, "user-a", "rec-normal", "rec-new");
    await updateCognitiveConfidence(exec, "user-a", "rec-normal", 0.2, "archived");

    expect(rows).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("excludes learned projections from durable promotion while retaining returned ordinary counts", async () => {
    const rows = vi.fn(async (_sql: string, _params: unknown[]) => [
      { record_id: "rec-normal-a" },
      { record_id: "rec-normal-b" },
    ]);

    const promoted = await promoteDurableMemories(
      { rows } as unknown as Executor,
      0.8,
      2,
    );

    expect(rows.mock.calls[0]?.[0]).toContain("metadata_json::jsonb -> 'learned' IS NULL");
    expect(promoted).toBe(2);
  });
});
