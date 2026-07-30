import { describe, expect, it, vi } from "vitest";
import { expireAuthorizedAssessmentEvidence } from "./assessmentEvidenceQueries.js";

describe("authorized-assessment evidence expiry", () => {
  it("selects only expired terminal assessment jobs and is a no-op when none qualify", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [],
      rowCount: 0,
    }));
    const tx = vi.fn(async (run) => run({ query }));

    await expect(expireAuthorizedAssessmentEvidence({ tx } as never, {
      now: "2026-08-30T00:00:00.000Z",
    })).resolves.toEqual({
      jobsExpired: 0,
      evidenceRowsDeleted: 0,
      findingsScrubbed: 0,
      stageReceiptsScrubbed: 0,
      sourceReceiptsScrubbed: 0,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("kind IN ('domain-pentest', 'pr-pentest')");
    expect(sql).toContain("status IN ('done', 'failed', 'cancelled')");
    expect(sql).toContain("retentionDays");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("evidenceExpiredAt");
    expect(sql).not.toContain("status IN ('pending', 'running')");
    expect(params).toEqual(["2026-08-30T00:00:00.000Z"]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("deletes detailed evidence while retaining a bounded expiry receipt", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("SELECT id,")) {
        return { rows: [{ id: "job-1", retention_days: 30 }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM repository_assurance_evidence")) {
        return { rows: [], rowCount: 4 };
      }
      if (sql.includes("UPDATE repository_assurance_findings")) {
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes("UPDATE repository_assurance_stages")) {
        return { rows: [], rowCount: 3 };
      }
      if (sql.includes("UPDATE repository_source_snapshots")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const tx = vi.fn(async (run) => run({ query }));

    await expect(expireAuthorizedAssessmentEvidence({ tx } as never, {
      now: "2026-08-30T00:00:00.000Z",
    })).resolves.toEqual({
      jobsExpired: 1,
      evidenceRowsDeleted: 4,
      findingsScrubbed: 2,
      stageReceiptsScrubbed: 3,
      sourceReceiptsScrubbed: 1,
    });

    const calls = query.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.includes("- 'findingsDetail'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("- 'workspaceRoot'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("progress_json = jsonb_build_array"))).toBe(true);
    expect(calls.some((sql) => sql.includes("provenance_json = '[]'::jsonb"))).toBe(true);
    expect(calls.some((sql) => sql.includes("input_refs_json = '[]'::jsonb"))).toBe(true);
    expect(calls.some((sql) => sql.includes("checkout_ref = NULL"))).toBe(true);
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      "2026-08-30T00:00:00.000Z",
      ["job-1"],
      [30],
    ]);
  });
});
