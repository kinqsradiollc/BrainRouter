import { describe, expect, it, vi } from "vitest";
import { listReviewAnalyticsForOrg, listReviewFindingsForOrg, listReviewJobSummariesForOrg, listReviewJobsForPr } from "./jobQueries.js";

function executor(rowFactory: (sql: string, params: unknown[]) => unknown[] = () => []) {
  return {
    rows: vi.fn(async (sql: string, params: unknown[]) => rowFactory(sql, params)),
  } as any;
}

describe("review dashboard job projections", () => {
  it("loads latest PR states without progress or finding-detail payloads", async () => {
    const exec = executor();
    await listReviewJobSummariesForOrg(exec, "org-1");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("jsonb_build_object");
    expect(sql).not.toContain("findingsDetail");
    expect(sql).toContain("'[]'::text AS progress_json");
    expect(sql).not.toMatch(/\bprogress_json\s+FROM\b/);
    expect(params).toEqual(["org-1", 2_000]);
  });

  it("loads one PR's full activity with an indexed org/repo/number predicate", async () => {
    const exec = executor();
    await listReviewJobsForPr(exec, "org-1", "owner/repo", 42);
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("(input_json::jsonb ->> 'repo') =");
    expect(sql).toContain("(input_json::jsonb ->> 'prNumber') =");
    expect(params).toEqual(["org-1", "owner/repo", "42", 50]);
  });

  it("projects analytics facts without progress or finding bodies", async () => {
    const exec = executor();
    await listReviewAnalyticsForOrg(exec, "org-1", "2026-06-15T00:00:00.000Z");
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("'severity'");
    expect(sql).toContain("'[]'::text AS progress_json");
    expect(sql).not.toContain("title");
    expect(sql).not.toContain("summary");
    expect(params).toEqual(["org-1", "2026-06-15T00:00:00.000Z", 1_000]);
  });

  it("pushes issue filters and keyset cursor into SQL", async () => {
    const exec = executor();
    await listReviewFindingsForOrg(exec, "org-1", {
      limit: 25,
      severity: "high",
      repo: "owner/repo",
      status: "open",
      search: "unsafe input",
      cursor: { createdAt: "2026-07-15T00:00:00.000Z", reviewId: "job-9", ordinal: 3 },
      sort: "oldest",
    });
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("WITH ORDINALITY");
    expect(sql).toContain("LOWER(finding ->> 'severity')");
    expect(sql).toContain("ILIKE");
    expect(sql).toContain("(created_at, review_id, ordinal) >");
    expect(sql).toContain("ORDER BY created_at ASC");
    expect(params).toContain("%unsafe input%");
    expect(params.at(-1)).toBe(26);
  });
});
