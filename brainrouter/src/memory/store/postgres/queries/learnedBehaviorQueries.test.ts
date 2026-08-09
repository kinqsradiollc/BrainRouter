import { describe, expect, it, vi } from "vitest";
import type { Executor } from "./executor.js";
import {
  getHostedLearnedLifecycle,
  retrieveHostedLearnedRecords,
  listHostedLearnedRecords,
  noteHostedLearningOutcomes,
  revertHostedLearnedRecord,
  syncHostedLearnedRecord,
  takeHostedLearnedRetirementBatch,
  transitionHostedLearnedLifecycle,
} from "./learnedBehaviorQueries.js";

const SESSION_A = "a".repeat(64);

function row(overrides: Record<string, unknown> = {}) {
  return {
    record_id: "rec-1",
    user_id: "user-a",
    org_id: "org-a",
    session_key: "session-a",
    content: "Prefer the focused typecheck.",
    type: "lesson",
    created_time: "2026-08-09T00:00:00.000Z",
    updated_time: "2026-08-09T00:00:00.000Z",
    metadata_json: JSON.stringify({
      learned: {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        status: "active",
        memoryLifecycle: { status: "active", attempts: 1 },
      },
    }),
    status: "active",
    archived: 0,
    ...overrides,
  };
}

describe("hosted learned behavior Postgres queries", () => {
  it("binds both owner and organization when listing", async () => {
    const rows = vi.fn(async () => [row()]);
    const exec = { rows } as unknown as Executor;
    const records = await listHostedLearnedRecords(exec, "user-a", "org-a", 999);
    expect(records).toHaveLength(1);
    expect(rows).toHaveBeenCalledWith(
      expect.stringContaining("WHERE user_id = $1"),
      ["user-a", "org-a", 201],
    );
    const firstSql = (rows.mock.calls as unknown as Array<[string, unknown[]]>)[0]?.[0];
    expect(firstSql).toContain("org_id = $2");
    expect(firstSql).toContain("metadata_json::jsonb -> 'learned'");
  });

  it("locks and advances a tenant retirement cursor with deterministic wrap", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT last_created_time")) {
          return { rows: [{ last_created_time: "2026-08-09T02:00:00.000Z", last_record_id: "rec-2" }] };
        }
        if (sql.includes("> ($3, $4)")) {
          return { rows: [row({ record_id: "rec-3", created_time: "2026-08-09T03:00:00.000Z" })] };
        }
        if (sql.includes("<= ($3, $4)")) {
          return { rows: [row({ record_id: "rec-1", created_time: "2026-08-09T01:00:00.000Z" })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const records = await takeHostedLearnedRetirementBatch(
      exec, "user-a", "org-a", 999, new Date("2026-08-09T04:00:00.000Z"),
    );

    expect(records.map((record) => record.id)).toEqual(["rec-3", "rec-1"]);
    expect(queries[0]).toMatchObject({
      params: ["org-a", "user-a", "2026-08-09T04:00:00.000Z"],
    });
    expect(queries[0].sql).toContain("ON CONFLICT (org_id, user_id) DO NOTHING");
    expect(queries[1].sql).toContain("FOR UPDATE");
    expect(queries[1].params).toEqual(["org-a", "user-a"]);
    expect(queries[2].sql).toContain("'status' IN ('active', 'demoted')");
    expect(queries[2].sql).toContain("ORDER BY created_time ASC, record_id ASC");
    expect(queries[2].params).toEqual([
      "user-a", "org-a", "2026-08-09T02:00:00.000Z", "rec-2", 201,
    ]);
    expect(queries[3].params).toEqual([
      "user-a", "org-a", "2026-08-09T02:00:00.000Z", "rec-2", 200,
    ]);
    expect(queries[4].params).toEqual([
      "2026-08-09T01:00:00.000Z", "rec-1", "2026-08-09T04:00:00.000Z", "org-a", "user-a",
    ]);
  });

  it("starts a retirement cursor at the oldest eligible key without wrapping", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT last_created_time")) {
          return { rows: [{ last_created_time: null, last_record_id: null }] };
        }
        if (sql.includes("> ($3, $4)")) {
          return { rows: [
            row({ record_id: "rec-1", created_time: "2026-08-09T01:00:00.000Z" }),
            row({ record_id: "rec-2", created_time: "2026-08-09T02:00:00.000Z" }),
          ] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const records = await takeHostedLearnedRetirementBatch(exec, "user-a", "org-a", 2);

    expect(records.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
    expect(queries.some((query) => query.sql.includes("<= ($3, $4)"))).toBe(false);
    expect(queries.at(-1)?.params.slice(0, 2)).toEqual(["2026-08-09T02:00:00.000Z", "rec-2"]);
  });

  it("locks, marks explicit human revert, archives, and audits in one transaction", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [row()] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: "archived", archived: 1, updated_time: params[1] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const result = await revertHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "lrn_0123456789abcdef01",
      "The tool contract changed",
      new Date("2026-08-09T02:00:00.000Z"),
    );

    expect(result).toMatchObject({ status: "archived", archived: true, orgId: "org-a" });
    expect(queries[0].sql).toContain("org_id = $2");
    expect(queries[0].sql).toContain("FOR UPDATE");
    expect(queries[0].params).toEqual(["user-a", "org-a", "lrn_0123456789abcdef01"]);
    const metadata = JSON.parse(String(queries[1].params[0]));
    expect(metadata.learned).toMatchObject({
      status: "reverted",
      statusReason: "The tool contract changed",
      statusChangedAt: "2026-08-09T02:00:00.000Z",
      memoryLifecycle: { status: "archived" },
    });
    expect(queries[1].sql).toContain("archived = 1");
    expect(queries[2].sql).toContain("learned_item_revert");
    expect(JSON.parse(String(queries[2].params.at(-1)))).toMatchObject({
      itemId: "lrn_0123456789abcdef01",
      orgId: "org-a",
    });
  });

  it("retrieves only active tenant rows and increments their outcome counters atomically", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const selected = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          tier: "instruction",
          origin: "human-correction",
          form: "lesson",
          status: "active",
          falsifier: "the focused check does not cover the changed package",
          expectation: "handoffs contain fewer type failures",
          provenance: { capturedAt: "2026-08-09T00:00:00.000Z" },
          outcome: { retrievals: 2, confirmations: 1, contradictions: 0 },
        },
      }),
    });
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("WITH prompt_eligible AS")) return { rows: [selected] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], updated_time: params[1] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const records = await retrieveHostedLearnedRecords(
      exec, "user-a", "org-a", 99, new Date("2026-08-09T03:00:00.000Z"),
    );
    expect(records).toHaveLength(1);
    expect(queries[0].sql).toContain("org_id = $2");
    expect(queries[0].sql).toContain("status = 'active'");
    expect(queries[0].sql).toContain("LIMIT $3");
    expect(queries[0].sql).toContain("FOR UPDATE");
    expect(queries[0].sql).toContain("FOR UPDATE OF records");
    expect(queries[0].sql).toContain("'itemId' ~ '^lrn_[a-f0-9]{18}$'");
    expect(queries[0].sql).toContain("'origin' = 'human-correction'");
    expect(queries[0].sql).toContain("'origin' IN ('model-inferred', 'human-correction')");
    expect(queries[0].sql).toContain("'form' = 'lesson'");
    expect(queries[0].sql.match(/LIMIT LEAST\(\$3, 8\)/g)).toHaveLength(2);
    expect(queries[0].params).toEqual(["user-a", "org-a", 16]);
    const metadata = JSON.parse(String(queries[1].params[0]));
    expect(metadata.learned.outcome).toMatchObject({
      retrievals: 3,
      confirmations: 1,
      lastRetrievedAt: "2026-08-09T03:00:00.000Z",
    });
  });

  it("records one session observation and immediately archives a contradiction", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const active = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "active",
          outcome: { retrievals: 1, confirmations: 0, contradictions: 0 },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      }),
    });
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT * FROM cognitive_records")) return { rows: [active] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2], updated_time: params[3] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const result = await noteHostedLearningOutcomes(
      exec, "user-a", "org-a", SESSION_A, "job-1",
      [
        { id: "lrn_0123456789abcdef01", outcome: "confirmed", detail: "the check first appeared successful" },
        { id: "lrn_0123456789abcdef01", outcome: "contradicted", detail: "API_KEY=super-secret-value" },
        { id: "lrn_0123456789abcdef01", outcome: "confirmed", detail: "a later duplicate cannot override the falsifier" },
      ],
      new Date("2026-08-09T04:00:00.000Z"),
      "rec-1",
    );
    expect(result).toHaveLength(1);
    expect(queries[0]?.sql).toContain("($4::text IS NULL OR record_id = $4)");
    expect(queries[0]?.params).toEqual([
      "user-a", "org-a", "lrn_0123456789abcdef01", "rec-1",
    ]);
    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    const metadata = JSON.parse(String(update.params[0]));
    expect(metadata.learned).toMatchObject({
      status: "retired",
      outcome: { contradictions: 1, lastContradictedAt: "2026-08-09T04:00:00.000Z" },
      memoryLifecycle: { status: "archived", attempts: 2 },
    });
    expect(metadata.learned.statusReason).toContain("[REDACTED]");
    expect(metadata.learned.statusReason).not.toContain("super-secret-value");
    expect(metadata.learned.checkpointJobIds).toBeUndefined();
    expect(update.params.slice(1, 3)).toEqual(["archived", 1]);
    const observation = queries.find((query) => query.sql.includes("INSERT INTO hosted_learning_outcome_observations"));
    expect(observation?.params).toEqual([
      "org-a", "user-a", "lrn_0123456789abcdef01", SESSION_A,
      "contradicted", "job-1", "2026-08-09T04:00:00.000Z",
    ]);
    expect(queries.at(-1)?.sql).toContain("learned_item_outcome");
  });

  it("does not count a different job or delayed retry twice in one logical session", async () => {
    const active = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "active",
          outcome: { retrievals: 1, confirmations: 1, contradictions: 0 },
        },
      }),
    });
    const queries: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT * FROM cognitive_records")) return { rows: [active] };
      if (sql.includes("SELECT outcome FROM hosted_learning_outcome_observations")) {
        return { rows: [{ outcome: "confirmed" }] };
      }
      return { rows: [] };
    }) };
    const exec = { tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)) } as unknown as Executor;
    await expect(noteHostedLearningOutcomes(
      exec, "user-a", "org-a", SESSION_A, "job-after-more-than-16-others",
      [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail: "the check passed" }],
    )).resolves.toEqual([]);
    expect(queries.some((sql) => sql.includes("UPDATE cognitive_records"))).toBe(false);
    expect(queries.some((sql) => sql.includes("SET last_job_id"))).toBe(true);
  });

  it("moves one session from confirmed to contradicted and never permits the inverse", async () => {
    const active = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "active",
          outcome: { retrievals: 1, confirmations: 1, contradictions: 0, lastConfirmedAt: "2026-08-09T03:00:00.000Z" },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT * FROM cognitive_records")) return { rows: [active] };
      if (sql.includes("SELECT outcome FROM hosted_learning_outcome_observations")) {
        return { rows: [{ outcome: "confirmed" }] };
      }
      if (sql.includes("UPDATE cognitive_records")) {
        return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2], updated_time: params[3] })] };
      }
      return { rows: [] };
    }) };
    const exec = { tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)) } as unknown as Executor;
    await expect(noteHostedLearningOutcomes(
      exec, "user-a", "org-a", SESSION_A, "job-contradiction",
      [{ id: "lrn_0123456789abcdef01", outcome: "contradicted", detail: "the falsifier happened" }],
      new Date("2026-08-09T04:00:00.000Z"),
    )).resolves.toHaveLength(1);
    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    const learned = JSON.parse(String(update.params[0])).learned;
    expect(learned.outcome).toMatchObject({ confirmations: 0, contradictions: 1 });
    expect(learned.outcome.lastConfirmedAt).toBeUndefined();
    expect(queries.some((query) => query.sql.includes("SET outcome = 'contradicted'"))).toBe(true);

    const contradictedClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT * FROM cognitive_records")) return { rows: [active] };
        if (sql.includes("SELECT outcome FROM hosted_learning_outcome_observations")) {
          return { rows: [{ outcome: "contradicted" }] };
        }
        return { rows: [] };
      }),
    };
    const contradictedExec = {
      tx: vi.fn(async (work: (value: typeof contradictedClient) => Promise<unknown>) => work(contradictedClient)),
    } as unknown as Executor;
    await expect(noteHostedLearningOutcomes(
      contradictedExec, "user-a", "org-a", SESSION_A, "job-later-confirmation",
      [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail: "later success" }],
    )).resolves.toEqual([]);
    expect(contradictedClient.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE cognitive_records"))).toBe(false);
  });

  it("restores a just-demoted delivered item when that session confirms it", async () => {
    const demoted = row({
      status: "archived",
      archived: 1,
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "demoted",
          statusChangedAt: "2026-08-09T04:00:00.000Z",
          outcome: { retrievals: 5, confirmations: 0, contradictions: 0 },
          memoryLifecycle: { status: "archived", attempts: 2 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT * FROM cognitive_records")) return { rows: [demoted] };
      if (sql.includes("SELECT outcome FROM hosted_learning_outcome_observations")) return { rows: [] };
      if (sql.includes("UPDATE cognitive_records")) {
        return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2], updated_time: params[3] })] };
      }
      return { rows: [] };
    }) };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const result = await noteHostedLearningOutcomes(
      exec, "user-a", "org-a", SESSION_A, "job-threshold-confirmation",
      [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail: "the expected focused check passed" }],
      new Date("2026-08-09T04:00:01.000Z"),
    );
    expect(result).toHaveLength(1);
    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    const learned = JSON.parse(String(update.params[0])).learned;
    expect(learned).toMatchObject({
      status: "active",
      outcome: { retrievals: 5, confirmations: 1, contradictions: 0 },
      memoryLifecycle: { status: "active", attempts: 3 },
    });
    expect(update.params.slice(1, 3)).toEqual(["active", 0]);
  });

  it("returns not found without issuing a write for another tenant or unknown item", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    expect(await revertHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "lrn_0123456789abcdef01",
      "No longer valid",
    )).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("mirrors counters but never overwrites an explicit human revert", async () => {
    const reverted = row({
      status: "archived",
      archived: 1,
      metadata_json: JSON.stringify({
        learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01", status: "reverted" },
      }),
    });
    const client = { query: vi.fn(async () => ({ rows: [reverted] })) };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const result = await syncHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      { schemaVersion: 1, itemId: "lrn_0123456789abcdef01", status: "active" },
    );
    expect(result).toMatchObject({ applied: false, blockedByHumanRevert: true });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("preserves server authority and max-merges counters while an inactive item stays inactive", async () => {
    const existing = row({
      status: "archived",
      archived: 1,
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          tier: "evidence",
          origin: "model-inferred",
          form: "lesson",
          status: "demoted",
          statusReason: "low confirmation rate",
          statusChangedAt: "2026-08-09T01:00:00.000Z",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T01:00:00.000Z",
          provenance: { sessionKey: "server-session", evidence: ["server evidence"] },
          outcome: {
            retrievals: 5,
            confirmations: 2,
            contradictions: 0,
            lastRetrievedAt: "2026-08-09T02:00:00.000Z",
          },
          memoryLifecycle: { status: "archived", attempts: 4 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [existing] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const result = await syncHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      {
        schemaVersion: 1,
        itemId: "lrn_ffffffffffffffffff",
        tier: "instruction",
        origin: "human-correction",
        createdAt: "2099-01-01T00:00:00.000Z",
        provenance: { sessionKey: "forged-session", evidence: ["forged evidence"] },
        status: "active",
        outcome: {
          retrievals: 1,
          confirmations: 3,
          contradictions: 0,
          lastRetrievedAt: "2026-08-09T01:00:00.000Z",
        },
        memoryLifecycle: { status: "active", attempts: 1 },
      },
      new Date("2026-08-09T03:00:00.000Z"),
    );

    expect(result).toMatchObject({ applied: true, blockedByHumanRevert: false });
    expect(queries[0].sql).toContain("FOR UPDATE");
    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    const metadata = JSON.parse(String(update.params[0]));
    expect(metadata.learned).toMatchObject({
      itemId: "lrn_0123456789abcdef01",
      tier: "evidence",
      origin: "model-inferred",
      createdAt: "2026-08-09T00:00:00.000Z",
      provenance: { sessionKey: "server-session", evidence: ["server evidence"] },
      status: "demoted",
      outcome: {
        retrievals: 5,
        confirmations: 3,
        lastRetrievedAt: "2026-08-09T02:00:00.000Z",
      },
      memoryLifecycle: { status: "archived", attempts: 4 },
    });
    expect(update.params.slice(1, 3)).toEqual(["archived", 1]);
  });

  it("never lets aggregate retirement erase another session's confirmation", async () => {
    const existing = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          tier: "evidence",
          origin: "model-inferred",
          status: "active",
          outcome: {
            retrievals: 1,
            confirmations: 1,
            contradictions: 0,
            lastConfirmedAt: "2026-08-09T01:00:00.000Z",
          },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [existing] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const result = await syncHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        status: "retired",
        statusReason: "falsifier observed in the same logical session",
        outcome: {
          retrievals: 1,
          confirmations: 0,
          contradictions: 1,
          lastContradictedAt: "2026-08-09T02:00:00.000Z",
        },
        memoryLifecycle: { status: "archived", attempts: 2 },
      },
      new Date("2026-08-09T02:00:00.000Z"),
    );

    expect(result).toMatchObject({ applied: true, blockedByHumanRevert: false });
    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    const learned = JSON.parse(String(update.params[0])).learned;
    expect(learned).toMatchObject({
      status: "retired",
      outcome: {
        retrievals: 1,
        confirmations: 1,
        contradictions: 1,
        lastConfirmedAt: "2026-08-09T01:00:00.000Z",
        lastContradictedAt: "2026-08-09T02:00:00.000Z",
      },
      memoryLifecycle: { status: "archived", attempts: 2 },
    });
    expect(update.params.slice(1, 3)).toEqual(["archived", 1]);
  });

  it("keeps max-merged confirmations when contradictions rise without retiring the item", async () => {
    const existing = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "active",
          outcome: { retrievals: 1, confirmations: 1, contradictions: 0 },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [existing] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2] })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    await syncHostedLearnedRecord(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        status: "demoted",
        outcome: { retrievals: 1, confirmations: 0, contradictions: 1 },
        memoryLifecycle: { status: "archived", attempts: 2 },
      },
    );

    const update = queries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    expect(JSON.parse(String(update.params[0])).learned.outcome).toMatchObject({
      confirmations: 1,
      contradictions: 1,
    });
  });

  it("syncs a human instruction's one-way evidence demotion and keeps it retrieval-eligible", async () => {
    const existing = row({
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          tier: "instruction",
          origin: "human-correction",
          form: "lesson",
          status: "active",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
          provenance: { sessionKey: "server-session", capturedAt: "2026-08-09T00:00:00.000Z" },
          outcome: { retrievals: 0, confirmations: 0, contradictions: 0 },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      }),
    });
    const syncQueries: Array<{ sql: string; params: unknown[] }> = [];
    const syncClient = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        syncQueries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [existing] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: params[1], archived: params[2] })] };
        }
        return { rows: [] };
      }),
    };
    const syncExec = {
      tx: vi.fn(async (work: (value: typeof syncClient) => Promise<unknown>) => work(syncClient)),
    } as unknown as Executor;

    const synced = await syncHostedLearnedRecord(
      syncExec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        tier: "evidence",
        origin: "human-correction",
        status: "active",
        statusReason: "instruction payoff fell below threshold; Bearer super-secret-value",
        outcome: { retrievals: 0, confirmations: 0, contradictions: 0 },
        memoryLifecycle: { status: "active", attempts: 1 },
      },
      new Date("2026-08-09T01:00:00.000Z"),
    );

    expect(synced).toMatchObject({ applied: true, blockedByHumanRevert: false });
    const syncUpdate = syncQueries.find((query) => query.sql.includes("UPDATE cognitive_records"))!;
    expect(JSON.parse(String(syncUpdate.params[0])).learned).toMatchObject({
      tier: "evidence",
      origin: "human-correction",
      status: "active",
      statusChangedAt: "2026-08-09T01:00:00.000Z",
    });
    const demotionReason = JSON.parse(String(syncUpdate.params[0])).learned.statusReason;
    expect(demotionReason).toContain("instruction payoff fell below threshold");
    expect(demotionReason).toContain("[REDACTED]");
    expect(demotionReason).not.toContain("super-secret-value");
    expect(syncUpdate.params.slice(1, 3)).toEqual(["active", 0]);

    const retrievalQueries: Array<{ sql: string; params: unknown[] }> = [];
    const retrievalClient = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        retrievalQueries.push({ sql, params });
        if (sql.includes("WITH prompt_eligible AS")) return { rows: [] };
        return { rows: [] };
      }),
    };
    const retrievalExec = {
      tx: vi.fn(async (work: (value: typeof retrievalClient) => Promise<unknown>) => work(retrievalClient)),
    } as unknown as Executor;
    await retrieveHostedLearnedRecords(retrievalExec, "user-a", "org-a", 16);
    expect(retrievalQueries[0].sql).toContain(
      "'origin' IN ('model-inferred', 'human-correction')",
    );
  });

  it.each(["demoted", "retired"] as const)(
    "does not resurrect a centrally %s learned status from a stale active projection",
    async (status) => {
      const inactive = row({
        status: "archived",
        archived: 1,
        metadata_json: JSON.stringify({
          learned: {
            schemaVersion: 1,
            itemId: "lrn_0123456789abcdef01",
            status,
            outcome: { retrievals: 2, confirmations: 1, contradictions: 0 },
            memoryLifecycle: { status: "archived", attempts: 2 },
          },
        }),
      });
      const client = { query: vi.fn(async () => ({ rows: [inactive] })) };
      const exec = {
        tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
      } as unknown as Executor;

      const result = await syncHostedLearnedRecord(
        exec,
        "user-a",
        "org-a",
        "rec-1",
        "lrn_0123456789abcdef01",
        {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "active",
          outcome: { retrievals: 2, confirmations: 1, contradictions: 0 },
          memoryLifecycle: { status: "active", attempts: 1 },
        },
      );

      expect(result).toMatchObject({ applied: false, blockedByHumanRevert: false });
      expect(client.query).toHaveBeenCalledTimes(1);
    },
  );

  it("inspects lifecycle with record, owner, org, and learned item predicates", async () => {
    const one = vi.fn(async (_sql: string, _params: unknown[]) => row());
    const result = await getHostedLearnedLifecycle(
      { one } as unknown as Executor,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
    );
    expect(result).toMatchObject({ learnedStatus: "active", memoryStatus: "active", applied: false });
    const [sql, params] = one.mock.calls[0]!;
    expect(sql).toContain("record_id = $1");
    expect(sql).toContain("user_id = $2");
    expect(sql).toContain("org_id = $3");
    expect(sql).toContain("->> 'itemId' = $4");
    expect(params).toEqual(["rec-1", "user-a", "org-a", "lrn_0123456789abcdef01"]);
  });

  it("archives the exact tenant projection and audits the lifecycle transition", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [row()] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: "archived", archived: 1 })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const result = await transitionHostedLearnedLifecycle(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      "archive",
      "capacity retirement",
      new Date("2026-08-09T03:00:00.000Z"),
    );
    expect(result).toMatchObject({ memoryStatus: "archived", applied: true, blockedByHumanRevert: false });
    expect(queries[0].sql).toContain("FOR UPDATE");
    expect(queries[0].params).toEqual([
      "rec-1", "user-a", "org-a", "lrn_0123456789abcdef01",
    ]);
    expect(queries[1].sql).toContain("record_id = $5 AND user_id = $6 AND org_id = $7");
    expect(queries[2].params[3]).toBe("learned_item_archive");
  });

  it("CAS-restores only a demoted item with a fresh central confirmation", async () => {
    const demoted = row({
      status: "archived",
      archived: 1,
      metadata_json: JSON.stringify({
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          status: "demoted",
          statusChangedAt: "2026-08-09T01:00:00.000Z",
          outcome: {
            retrievals: 5,
            confirmations: 1,
            contradictions: 0,
            lastConfirmedAt: "2026-08-09T02:00:00.000Z",
          },
          memoryLifecycle: { status: "archived", attempts: 2 },
        },
      }),
    });
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT *")) return { rows: [demoted] };
        if (sql.includes("UPDATE cognitive_records")) {
          return { rows: [row({ metadata_json: params[0], status: "active", archived: 0 })] };
        }
        return { rows: [] };
      }),
    };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;

    const result = await transitionHostedLearnedLifecycle(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      "restore",
      "confirmed after demotion",
      new Date("2026-08-09T03:00:00.000Z"),
    );

    expect(result).toMatchObject({
      learnedStatus: "active",
      memoryStatus: "active",
      applied: true,
      blockedByHumanRevert: false,
    });
    expect(queries[0].sql).toContain("FOR UPDATE");
    const metadata = JSON.parse(String(queries[1].params[0]));
    expect(metadata.learned).toMatchObject({
      status: "active",
      statusReason: "confirmed after demotion",
      statusChangedAt: "2026-08-09T03:00:00.000Z",
      memoryLifecycle: { status: "active", attempts: 3 },
    });
    expect(queries[1].params.slice(1, 3)).toEqual(["active", 0]);
  });

  it("does not restore a centrally human-reverted projection", async () => {
    const reverted = row({
      status: "archived",
      archived: 1,
      metadata_json: JSON.stringify({
        learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01", status: "reverted" },
      }),
    });
    const client = { query: vi.fn(async () => ({ rows: [reverted] })) };
    const exec = {
      tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    } as unknown as Executor;
    const result = await transitionHostedLearnedLifecycle(
      exec,
      "user-a",
      "org-a",
      "rec-1",
      "lrn_0123456789abcdef01",
      "restore",
      "local item active",
    );
    expect(result).toMatchObject({ applied: false, blockedByHumanRevert: true });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it.each(["demoted", "retired"] as const)(
    "does not restore a %s item without a qualifying post-demotion confirmation",
    async (status) => {
      const inactive = row({
        status: "archived",
        archived: 1,
        metadata_json: JSON.stringify({
          learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01", status },
        }),
      });
      const client = { query: vi.fn(async () => ({ rows: [inactive] })) };
      const exec = {
        tx: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
      } as unknown as Executor;
      const result = await transitionHostedLearnedLifecycle(
        exec,
        "user-a",
        "org-a",
        "rec-1",
        "lrn_0123456789abcdef01",
        "restore",
        "local stale state",
      );
      expect(result).toMatchObject({ applied: false, blockedByHumanRevert: false });
      expect(client.query).toHaveBeenCalledTimes(1);
    },
  );
});
