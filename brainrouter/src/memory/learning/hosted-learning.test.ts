import { describe, expect, it, vi } from "vitest";
import {
  buildHostedHumanCorrection,
  enqueueHostedLearningCheckpoint,
  hostedLearnedItemId,
} from "./hosted-learning.js";

describe("hosted ADR-032 boundaries", () => {
  it("mints stable tenant-specific ids and validates correction fields through the shared gate", () => {
    const tenant = { userId: "user-a", orgId: "org-a" };
    const statement = "Use merge commits when integrating release branches.";
    expect(hostedLearnedItemId(tenant, statement, "human-correction"))
      .toBe(hostedLearnedItemId(tenant, statement, "human-correction"));
    expect(hostedLearnedItemId({ ...tenant, orgId: "org-b" }, statement, "human-correction"))
      .not.toBe(hostedLearnedItemId(tenant, statement, "human-correction"));
    expect(buildHostedHumanCorrection({
      tenant,
      sessionKey: "host-stamped",
      statement,
      falsifier: "a squash merge preserves the required release ancestry",
      expectation: "the release ancestry remains visible after integration",
    })).toMatchObject({ admitted: true, item: { tier: "instruction", origin: "human-correction" } });
  });

  it("does only one durable queue call with bounded tenant-stamped input", async () => {
    const admissions: Array<{
      userId: string;
      orgId: string;
      sessionKeyHash: string;
      requestKey: string;
      jobInput: Record<string, unknown>;
    }> = [];
    const enqueue = vi.fn(async (admission: typeof admissions[number]) => {
      admissions.push(admission);
      return {
      admitted: true as const,
      reason: "admitted" as const,
      jobId: "job-1",
      sessionSpent: 1,
      tenantSpent: 1,
      };
    });
    const result = await enqueueHostedLearningCheckpoint({
      enqueueHostedLearningCheckpointJob: enqueue,
    }, {
      userId: " user-a ",
      orgId: " org-a ",
      sessionKey: "session-a",
      reason: "turn-end",
      trajectory: ` user: ${"x".repeat(30_000)} `,
      sawUntrustedContent: true,
      corroboratedByTrustedAction: false,
      model: "model-a",
      retrievedItemIds: ["lrn_0123456789abcdef01"],
    });
    expect(result.admitted).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const admission = admissions[0]!;
    expect(admission).toMatchObject({ userId: "user-a", orgId: "org-a" });
    expect(admission.sessionKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(admission.requestKey).toMatch(/^[a-f0-9]{64}$/);
    expect(String(admission.jobInput.trajectory)).toHaveLength(24_000);
    expect(admission.jobInput).toMatchObject({
      userId: "user-a",
      orgId: "org-a",
      sessionKey: "session-a",
      sawUntrustedContent: true,
      corroboratedByTrustedAction: false,
    });
  });

  it("redacts secrets before the trajectory enters the durable job row", async () => {
    const admissions: Array<{ jobInput: Record<string, unknown> }> = [];
    await enqueueHostedLearningCheckpoint({
      enqueueHostedLearningCheckpointJob: async (input) => {
        admissions.push(input);
        return { admitted: true, reason: "admitted", jobId: "job", sessionSpent: 1, tenantSpent: 1 };
      },
    }, {
      userId: "user-a",
      orgId: "org-a",
      sessionKey: "session-a",
      reason: "turn-end",
      trajectory: `user: API_KEY=super-secret-value\n${"context ".repeat(60)}`,
      sawUntrustedContent: false,
      corroboratedByTrustedAction: false,
      model: "model-a",
      retrievedItemIds: [],
    });
    expect(String(admissions[0]?.jobInput.trajectory)).not.toContain("super-secret-value");
    expect(String(admissions[0]?.jobInput.trajectory)).toContain("[REDACTED]");
  });

  it("canonicalizes the delivered set but separates authority-relevant request inputs", async () => {
    const admissions: Array<{ requestKey: string; jobInput: Record<string, unknown> }> = [];
    const store = {
      enqueueHostedLearningCheckpointJob: async (input: typeof admissions[number]) => {
        admissions.push(input);
        return { admitted: true as const, reason: "admitted" as const, jobId: "job", sessionSpent: 1, tenantSpent: 1 };
      },
    };
    const base = {
      userId: "user-a",
      orgId: "org-a",
      sessionKey: "session-a",
      reason: "turn-end" as const,
      trajectory: `user: repeated failure\n${"context ".repeat(60)}\nassistant: completed`,
      sawUntrustedContent: false,
      corroboratedByTrustedAction: false as const,
      model: "model-a",
      retrievedItemIds: ["lrn_1123456789abcdef01", "lrn_0123456789abcdef01"],
    };
    await enqueueHostedLearningCheckpoint(store, base);
    await enqueueHostedLearningCheckpoint(store, {
      ...base,
      retrievedItemIds: [...base.retrievedItemIds].reverse(),
    });
    await enqueueHostedLearningCheckpoint(store, { ...base, sawUntrustedContent: true });
    await enqueueHostedLearningCheckpoint(store, { ...base, reasoningEffort: "high" });
    await enqueueHostedLearningCheckpoint(store, {
      ...base,
      retrievedItemIds: [base.retrievedItemIds[0]!],
    });

    expect(admissions[0]?.requestKey).toBe(admissions[1]?.requestKey);
    expect(new Set(admissions.slice(0, 2).map((entry) => entry.requestKey)).size).toBe(1);
    expect(new Set(admissions.map((entry) => entry.requestKey)).size).toBe(4);
    expect(admissions[0]?.jobInput.retrievedItemIds).toEqual(base.retrievedItemIds);
    expect(admissions[1]?.jobInput.retrievedItemIds).toEqual([...base.retrievedItemIds].reverse());
  });

  it("fails closed if hosted code claims a trusted action or lacks durable admission", async () => {
    const base = {
      userId: "user-a",
      orgId: "org-a",
      sessionKey: "session-a",
      reason: "turn-end" as const,
      trajectory: `user: repeated failure\n${"context ".repeat(60)}\nassistant: observed it again`,
      sawUntrustedContent: false,
      model: "model-a",
      retrievedItemIds: [],
    };
    await expect(enqueueHostedLearningCheckpoint({}, {
      ...base,
      corroboratedByTrustedAction: false,
    })).rejects.toThrow("durable admission is unavailable");
    await expect(enqueueHostedLearningCheckpoint({
      enqueueHostedLearningCheckpointJob: vi.fn(),
    }, {
      ...base,
      corroboratedByTrustedAction: true as false,
    })).rejects.toThrow("cannot claim corroboration");
  });

  it("does not enqueue or spend budget on a greeting-sized trajectory", async () => {
    const enqueue = vi.fn();
    await expect(enqueueHostedLearningCheckpoint({
      enqueueHostedLearningCheckpointJob: enqueue,
    }, {
      userId: "user-a",
      orgId: "org-a",
      sessionKey: "session-a",
      reason: "turn-end",
      trajectory: "user: hello\nassistant: hello",
      sawUntrustedContent: false,
      corroboratedByTrustedAction: false,
      model: "model-a",
      retrievedItemIds: [],
    })).resolves.toMatchObject({ admitted: false, reason: "trajectory-too-short" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
