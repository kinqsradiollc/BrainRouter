import { describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor.js";
import { enqueueHostedLearningCheckpointJob } from "./hostedLearningQueries.js";

function harness(rows: {
  tenant?: Record<string, unknown>;
  session?: Record<string, unknown>;
  priorJob?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT spent FROM hosted_learning_tenant")) {
        return { rows: [rows.tenant ?? { spent: 0 }] };
      }
      if (sql.includes("SELECT spent, last_admitted_at")) {
        return { rows: [rows.session ?? { spent: 0, last_activity_at: "2026-08-09T00:00:00.000Z" }] };
      }
      if (sql.includes("SELECT id FROM memory_jobs")) {
        return { rows: rows.priorJob ? [rows.priorJob] : [] };
      }
      return { rows: [] };
    }),
  };
  const exec = {
    tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
  } as unknown as Executor;
  return { exec, calls };
}

const request = {
  userId: "user-a",
  orgId: "org-a",
  sessionKeyHash: "session-hash",
  requestKey: "request-hash",
  jobInput: { userId: "user-a", orgId: "org-a", trajectory: "bounded" },
};

describe("hosted learning durable admission", () => {
  it("locks tenant and session budgets and inserts the job in the same transaction", async () => {
    const { exec, calls } = harness();
    const result = await enqueueHostedLearningCheckpointJob(exec, request, {
      now: new Date("2026-08-09T01:00:00.000Z"),
      idGenerator: () => "job-1",
    });
    expect(result).toEqual({
      admitted: true,
      reason: "admitted",
      jobId: "job-1",
      sessionSpent: 1,
      tenantSpent: 1,
    });
    expect(calls.filter((call) => call.sql.includes("FOR UPDATE"))).toHaveLength(2);
    const insert = calls.find((call) => call.sql.includes("INSERT INTO memory_jobs"));
    expect(insert?.params).toEqual([
      "job-1", "hosted-learning-checkpoint", "2026-08-09T01:00:00.000Z",
      "org-a", "request-hash", JSON.stringify(request.jobInput),
      "2026-08-09T01:00:00.000Z", "2026-08-09T01:00:00.000Z",
    ]);
  });

  it("returns a prior job for a duplicate request without inserting or spending", async () => {
    const { exec, calls } = harness({
      tenant: { spent: 3 },
      session: {
        spent: 2,
        last_activity_at: "2026-08-09T00:59:30.000Z",
        last_admitted_at: "2026-08-09T00:59:30.000Z",
        last_request_key: "newer-request-hash",
        last_job_id: "job-newer",
      },
      priorJob: { id: "job-existing" },
    });
    const result = await enqueueHostedLearningCheckpointJob(exec, request, {
      now: new Date("2026-08-09T01:00:00.000Z"),
    });
    expect(result).toEqual({
      admitted: false,
      reason: "duplicate",
      jobId: "job-existing",
      sessionSpent: 2,
      tenantSpent: 3,
    });
    expect(calls.some((call) => call.sql.includes("INSERT INTO memory_jobs"))).toBe(false);
    expect(calls.find((call) => call.sql.includes("SELECT id FROM memory_jobs"))?.params)
      .toEqual(["hosted-learning-checkpoint", "org-a", "request-hash"]);
  });

  it("enforces both session and tenant model-call ceilings", async () => {
    const session = harness({ tenant: { spent: 4 }, session: { spent: 4, last_activity_at: "2026-08-09T00:50:00.000Z" } });
    await expect(enqueueHostedLearningCheckpointJob(session.exec, request, {
      now: new Date("2026-08-09T01:00:00.000Z"),
    })).resolves.toMatchObject({ admitted: false, reason: "session-budget" });

    const tenant = harness({ tenant: { spent: 64 }, session: { spent: 0, last_activity_at: "2026-08-09T00:50:00.000Z" } });
    await expect(enqueueHostedLearningCheckpointJob(tenant.exec, request, {
      now: new Date("2026-08-09T01:00:00.000Z"),
    })).resolves.toMatchObject({ admitted: false, reason: "tenant-budget" });
  });

  it("resets only the session budget after an idle boundary", async () => {
    const { exec } = harness({
      tenant: { spent: 7 },
      session: {
        spent: 4,
        last_activity_at: "2026-08-09T00:00:00.000Z",
        last_admitted_at: "2026-08-09T00:00:00.000Z",
        last_request_key: "old",
      },
    });
    await expect(enqueueHostedLearningCheckpointJob(exec, request, {
      now: new Date("2026-08-09T01:00:00.000Z"),
      idGenerator: () => "job-new-generation",
    })).resolves.toMatchObject({ admitted: true, sessionSpent: 1, tenantSpent: 8 });
  });
});
