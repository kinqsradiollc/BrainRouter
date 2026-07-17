import { describe, expect, it, vi } from "vitest";
import {
  cancelSupersededReviewJobs,
  claimNextMemoryJob,
  enqueueMemoryJob,
  listReviewAnalyticsForOrg,
  listReviewFindingsForOrg,
  listReviewJobSummariesForOrg,
  listReviewJobsForPr,
  tenantForJobInput,
} from "./jobQueries.js";

function executor(rowFactory: (sql: string, params: unknown[]) => unknown[] = () => []) {
  return {
    rows: vi.fn(async (sql: string, params: unknown[]) => rowFactory(sql, params)),
  } as any;
}

/** Captures the SELECT issued inside `claimNextMemoryJob`'s transaction. */
function claimExecutor() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; } };
  const exec = { tx: async (fn: (c: typeof client) => Promise<unknown>) => fn(client) } as any;
  return { exec, queries };
}

/** Captures `run` writes (INSERT/UPDATE) with a stub `one` for the read-back. */
function writeExecutor() {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const exec = {
    run: vi.fn(async (sql: string, params: unknown[]) => { runs.push({ sql, params }); return 1; }),
    one: vi.fn(async () => ({
      id: "id1", kind: "pr-security-review", status: "pending", priority: 50, attempts: 0, max_attempts: 3,
      run_after: "N", locked_at: null, parent_job_id: null, input_json: "{}", output_json: null,
      progress_json: "[]", error: null, created_at: "N", updated_at: "N",
    })),
  } as any;
  return { exec, runs };
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

describe("per-tenant fair scheduling", () => {
  it("tenantForJobInput resolves orgId, then userId, else null", () => {
    expect(tenantForJobInput({ orgId: "org1" })).toBe("org1");
    expect(tenantForJobInput({ userId: "u1" })).toBe("u1");
    expect(tenantForJobInput({ orgId: "org1", userId: "u1" })).toBe("org1"); // org wins
    expect(tenantForJobInput({ orgId: "  " })).toBeNull(); // blank ignored
    expect(tenantForJobInput({})).toBeNull();
    expect(tenantForJobInput(null)).toBeNull();
    expect(tenantForJobInput("nope")).toBeNull();
  });

  it("enqueueMemoryJob materializes tenant from the input payload", async () => {
    const { exec, runs } = writeExecutor();
    await enqueueMemoryJob(exec, { kind: "pr-security-review", input: { orgId: "org1", repo: "a/b", prNumber: 1 } }, { idGenerator: () => "id1", now: "N" });
    expect(runs[0]!.sql).toContain("tenant");
    // params: [id, kind, priority, maxAttempts, runAfter, parentJobId, tenant, input_json, created, updated]
    expect(runs[0]!.params[6]).toBe("org1");

    const user = writeExecutor();
    await enqueueMemoryJob(user.exec, { kind: "identity_distiller", input: { userId: "u1" } }, { idGenerator: () => "id2", now: "N" });
    expect(user.runs[0]!.params[6]).toBe("u1");

    const anon = writeExecutor();
    await enqueueMemoryJob(anon.exec, { kind: "some_job", input: {} }, { idGenerator: () => "id3", now: "N" });
    expect(anon.runs[0]!.params[6]).toBeNull(); // tenant-less → exempt from the cap
  });

  it("claimNextMemoryJob adds a running-count guard + limit param when perTenantLimit is set", async () => {
    const { exec, queries } = claimExecutor();
    await claimNextMemoryJob(exec, { perTenantLimit: 4, now: "N" });
    const sel = queries[0]!;
    expect(sel.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sel.sql).toContain("memory_jobs.tenant IS NULL");
    expect(sel.sql).toContain("r.status = 'running' AND r.tenant = memory_jobs.tenant");
    expect(sel.sql).toContain("< $2");
    expect(sel.sql).toContain("ORDER BY priority DESC, run_after ASC, id ASC");
    expect(sel.params).toEqual(["N", 4]);
  });

  it("claimNextMemoryJob stays uncapped without perTenantLimit (backward compatible)", async () => {
    const { exec, queries } = claimExecutor();
    await claimNextMemoryJob(exec, { now: "N" });
    const sel = queries[0]!;
    expect(sel.sql).not.toContain("r.tenant = memory_jobs.tenant");
    expect(sel.params).toEqual(["N"]);
  });

  it("cancelSupersededReviewJobs cancels pending reviews scoped to org/repo/PR", async () => {
    const { exec, runs } = writeExecutor();
    const n = await cancelSupersededReviewJobs(exec, { orgId: "org1", repo: "a/b", prNumber: 7 }, { now: "N" });
    expect(n).toBe(1); // returns exec.run's affected-row count
    const sql = runs[0]!.sql;
    expect(sql).toContain("status = 'cancelled'");
    expect(sql).toContain("status = 'pending'"); // running reviews are left to finish
    expect(sql).toContain("kind IN ('pr-security-review','pr-code-review')");
    expect(sql).toContain("tenant = $2");
    expect(runs[0]!.params).toEqual(["N", "org1", "a/b", "7"]);
  });
});
