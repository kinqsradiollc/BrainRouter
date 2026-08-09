import { describe, expect, it, vi } from "vitest";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";
import { runHostedLearningCheckpoint } from "./hosted-learning-executor.js";
import { hostedLearningSessionIdentity } from "./hosted-learning.js";

const quote = "tool: the migration failed because the worker still held the schema lock";

function job(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-a",
    orgId: "org-a",
    sessionKey: "dashboard:session-a",
    reason: "turn-end",
    trajectory: `${quote}\n${quote}\nuser: ${"context ".repeat(40)}\nassistant: I stopped the worker and retried the migration.`,
    sawUntrustedContent: false,
    corroboratedByTrustedAction: false,
    model: "model-a",
    retrievedItemIds: [],
    ...overrides,
  };
}

function learnedRecord(): CognitiveRecord {
  return {
    id: "record-1",
    userId: "user-a",
    orgId: "org-a",
    sessionKey: "prior",
    sessionId: "prior",
    content: "Stop the worker before applying a schema migration.",
    type: "lesson",
    priority: 80,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    timestampStr: "",
    timestampStart: "",
    timestampEnd: "",
    createdTime: "2026-08-09T00:00:00.000Z",
    updatedTime: "2026-08-09T00:00:00.000Z",
    metadata: {
      learned: {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        tier: "evidence",
        origin: "model-inferred",
        form: "lesson",
        status: "active",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        falsifier: "the migration succeeds while the worker still holds the schema lock",
        expectation: "schema migrations stop failing on the worker lock",
        provenance: {
          sessionKey: "prior",
          capturedAt: "2026-08-09T00:00:00.000Z",
          checkpoint: "turn-end",
          evidence: [quote],
          sawUntrustedContent: false,
          gateReasoning: "repeated and falsifiable",
        },
        outcome: { retrievals: 1, confirmations: 0, contradictions: 0 },
        memoryLifecycle: { status: "active", updatedAt: "2026-08-09T00:00:00.000Z", attempts: 1 },
      },
    },
    confidence: 0.8,
    status: "active",
    sourceKind: "model_inference",
    verificationStatus: "unverified",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
  };
}

function harness(raw: string) {
  const run = vi.fn(async () => raw);
  const modelRunner = vi.fn(async () => ({ run }));
  const recordLesson = vi.fn(async () => ({ recordId: "record-new", reinforced: false }));
  const store = {
    getHostedLearnedRecordByItemId: vi.fn(async (
      _userId: string,
      _orgId: string,
      _itemId: string,
    ): Promise<CognitiveRecord | null> => null),
    takeHostedLearnedRetirementBatch: vi.fn(async () => [] as CognitiveRecord[]),
    noteHostedLearningOutcomes: vi.fn(async () => [] as CognitiveRecord[]),
    syncHostedLearnedRecord: vi.fn(async () => ({ applied: true, blockedByHumanRevert: false })),
  };
  return { run, modelRunner, recordLesson, store };
}

describe("hosted learning checkpoint executor", () => {
  it("fails before provider resolution when durable executor capabilities are incomplete", async () => {
    const h = harness(JSON.stringify({ candidates: [], outcomes: [] }));
    await expect(runHostedLearningCheckpoint(job(), {
      store: {} as typeof h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-missing-store",
    })).rejects.toThrow("store capability getHostedLearnedRecordByItemId is unavailable");
    await expect(runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner } as any,
      jobId: "job-missing-engine",
    })).rejects.toThrow("engine capability recordLesson is unavailable");
    await expect(runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "",
    })).rejects.toThrow("requires a durable job id");
    expect(h.modelRunner).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("uses the exact active org runner and persists only gate-admitted evidence", async () => {
    const response = JSON.stringify({
      candidates: [{
        form: "lesson",
        statement: "Stop the worker before applying a schema migration.",
        falsifier: "the migration succeeds while the worker still holds the schema lock",
        expectation: "schema migrations stop failing on the worker lock",
        evidence: [quote],
      }],
      outcomes: [],
    });
    const h = harness(response);
    const result = await runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-1",
      now: new Date("2026-08-09T05:00:00.000Z"),
    });
    expect(result).toMatchObject({ ran: true, admitted: 1, rejected: 0 });
    expect(h.modelRunner).toHaveBeenCalledWith("learning-reflection", "org-a");
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ taskId: "hosted-learning:job-1" }));
    expect(h.recordLesson).toHaveBeenCalledWith(
      "user-a",
      "Stop the worker before applying a schema migration.",
      expect.objectContaining({
        orgId: "org-a",
        learned: expect.objectContaining({ tier: "evidence", origin: "model-inferred", form: "lesson" }),
      }),
    );
  });

  it("cannot persist a candidate derived from untrusted content without a runtime action trace", async () => {
    const h = harness(JSON.stringify({
      candidates: [{
        form: "lesson",
        statement: "Stop the worker before applying a schema migration.",
        falsifier: "the migration succeeds while the worker still holds the schema lock",
        expectation: "schema migrations stop failing on the worker lock",
        evidence: [quote],
      }],
      outcomes: [],
    }));
    const result = await runHostedLearningCheckpoint(job({ sawUntrustedContent: true }), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-2",
    });
    expect(result).toMatchObject({ admitted: 0, rejected: 1 });
    expect(h.recordLesson).not.toHaveBeenCalled();
  });

  it("limits outcomes to records actually retrieved in the completed turn", async () => {
    const detail = "assistant: I stopped the worker and retried the migration.";
    const h = harness(JSON.stringify({
      candidates: [],
      outcomes: [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail }],
    }));
    h.store.getHostedLearnedRecordByItemId.mockResolvedValue(learnedRecord());
    h.store.noteHostedLearningOutcomes.mockResolvedValue([learnedRecord()]);
    const result = await runHostedLearningCheckpoint(job({
      retrievedItemIds: ["lrn_0123456789abcdef01"],
    }), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-3",
    });
    expect(result.outcomes).toBe(1);
    expect(h.store.noteHostedLearningOutcomes).toHaveBeenCalledWith(
      "user-a", "org-a",
      hostedLearningSessionIdentity("user-a", "org-a", "dashboard:session-a"),
      "job-3",
      [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail }],
      expect.any(Date),
    );
  });

  it("keeps the exact delivered snapshot eligible when the pre-provider sweep demotes it", async () => {
    const detail = "assistant: I stopped the worker and retried the migration.";
    const h = harness(JSON.stringify({
      candidates: [],
      outcomes: [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail }],
    }));
    const threshold = learnedRecord();
    (threshold.metadata.learned as any).outcome = {
      retrievals: 5,
      confirmations: 0,
      contradictions: 0,
    };
    h.store.getHostedLearnedRecordByItemId.mockResolvedValue(threshold);
    h.store.takeHostedLearnedRetirementBatch.mockResolvedValue([threshold]);
    h.store.noteHostedLearningOutcomes.mockResolvedValue([learnedRecord()]);

    const result = await runHostedLearningCheckpoint(job({
      retrievedItemIds: ["lrn_0123456789abcdef01"],
    }), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-threshold",
      now: new Date("2026-08-09T06:00:00.000Z"),
    });

    expect(result).toMatchObject({ outcomes: 1, transitions: 1 });
    expect(h.store.getHostedLearnedRecordByItemId.mock.invocationCallOrder[0])
      .toBeLessThan(h.store.takeHostedLearnedRetirementBatch.mock.invocationCallOrder[0]!);
    expect(h.store.syncHostedLearnedRecord).toHaveBeenCalledWith(
      "user-a", "org-a", "record-1", "lrn_0123456789abcdef01",
      expect.objectContaining({ status: "demoted" }),
      new Date("2026-08-09T06:00:00.000Z"),
    );
    expect(h.store.noteHostedLearningOutcomes).toHaveBeenCalledWith(
      "user-a", "org-a",
      hostedLearningSessionIdentity("user-a", "org-a", "dashboard:session-a"),
      "job-threshold",
      [{ id: "lrn_0123456789abcdef01", outcome: "confirmed", detail }],
      new Date("2026-08-09T06:00:00.000Z"),
    );
  });

  it("throws on malformed model output so the durable queue retries", async () => {
    const h = harness("not JSON");
    await expect(runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-4",
    })).rejects.toThrow("contained no parseable JSON object");
    expect(h.recordLesson).not.toHaveBeenCalled();
  });

  it("canonicalizes polluted model JSON through the memory parser before reflection parsing", async () => {
    const h = harness('[assistant role]\n```json\n{"candidates":[],"outcomes":[],}\n```');
    const result = await runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-polluted-json",
    });
    expect(result).toMatchObject({ ran: true, admitted: 0, rejected: 0, outcomes: 0 });
  });

  it("completes deterministic retirement before a provider failure", async () => {
    const h = harness("not JSON");
    const retiring = learnedRecord();
    (retiring.metadata.learned as any).outcome.contradictions = 1;
    h.store.takeHostedLearnedRetirementBatch.mockResolvedValue([retiring]);

    await expect(runHostedLearningCheckpoint(job(), {
      store: h.store,
      engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
      jobId: "job-retirement-first",
      now: new Date("2026-08-09T06:00:00.000Z"),
    })).rejects.toThrow("contained no parseable JSON object");

    expect(h.store.takeHostedLearnedRetirementBatch).toHaveBeenCalledWith(
      "user-a", "org-a", 201, new Date("2026-08-09T06:00:00.000Z"),
    );
    expect(h.store.syncHostedLearnedRecord).toHaveBeenCalledWith(
      "user-a", "org-a", "record-1", "lrn_0123456789abcdef01",
      expect.objectContaining({ status: "retired" }),
      new Date("2026-08-09T06:00:00.000Z"),
    );
    expect(h.store.syncHostedLearnedRecord.mock.invocationCallOrder[0])
      .toBeLessThan(h.modelRunner.mock.invocationCallOrder[0]!);
  });

  it.each(["demoted", "retired", "reverted"] as const)(
    "does not resurrect a %s item from model re-derivation",
    async (status) => {
      const h = harness(JSON.stringify({
        candidates: [{
          form: "lesson",
          statement: "Stop the worker before applying a schema migration.",
          falsifier: "the migration succeeds while the worker still holds the schema lock",
          expectation: "schema migrations stop failing on the worker lock",
          evidence: [quote],
        }],
        outcomes: [],
      }));
      h.store.getHostedLearnedRecordByItemId.mockImplementation(async (_userId, _orgId, itemId) => {
        const existing = learnedRecord();
        (existing.metadata.learned as any).itemId = itemId;
        (existing.metadata.learned as any).status = status;
        existing.status = "archived";
        existing.archived = true;
        return existing;
      });

      const result = await runHostedLearningCheckpoint(job(), {
        store: h.store,
        engine: { modelRunner: h.modelRunner, recordLesson: h.recordLesson },
        jobId: `job-existing-${status}`,
      });

      expect(result).toMatchObject({ admitted: 0, rejected: 1 });
      expect(h.recordLesson).not.toHaveBeenCalled();
    },
  );
});
