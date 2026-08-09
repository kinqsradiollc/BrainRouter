import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revert: vi.fn(),
  sync: vi.fn(),
  inspect: vi.fn(),
  transition: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  addEvidence: vi.fn(),
  getEvidence: vi.fn(),
  exportMemories: vi.fn(),
  governanceDelete: vi.fn(),
  importMemories: vi.fn(),
}));

vi.mock("../../../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      revertHostedLearnedRecord: mocks.revert,
      syncHostedLearnedRecord: mocks.sync,
      getHostedLearnedLifecycle: mocks.inspect,
      transitionHostedLearnedLifecycle: mocks.transition,
    },
    getMemoryById: mocks.get,
    updateMemory: mocks.update,
    addEvidence: mocks.addEvidence,
    getEvidence: mocks.getEvidence,
    exportMemories: mocks.exportMemories,
    governanceDelete: mocks.governanceDelete,
    importMemories: mocks.importMemories,
  },
}));

import {
  handleHostLearningRequest,
  handleMemoryGovernanceTool,
  memoryGovernanceToolSchemas,
} from "./memory-governance.js";

function resultJson(result: Awaited<ReturnType<typeof handleMemoryGovernanceTool>>) {
  return JSON.parse(String((result as any).content[0].text));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revert.mockResolvedValue({ id: "rec-1", status: "archived" });
  mocks.sync.mockResolvedValue({
    record: { id: "rec-1", status: "active" },
    applied: true,
    blockedByHumanRevert: false,
  });
  mocks.inspect.mockResolvedValue({
    record: { id: "rec-1" },
    learnedStatus: "active",
    memoryStatus: "active",
    applied: false,
    blockedByHumanRevert: false,
  });
  mocks.transition.mockResolvedValue({
    record: { id: "rec-1" },
    learnedStatus: "retired",
    memoryStatus: "archived",
    applied: true,
    blockedByHumanRevert: false,
  });
  mocks.get.mockResolvedValue(null);
  mocks.update.mockResolvedValue(null);
  mocks.addEvidence.mockResolvedValue({ id: "evidence-1" });
  mocks.getEvidence.mockResolvedValue([]);
  mocks.exportMemories.mockResolvedValue({ version: 1, memories: [], evidence: [], operations: [] });
  mocks.governanceDelete.mockResolvedValue(undefined);
  mocks.importMemories.mockResolvedValue({ importedMemories: 0, importedEvidence: 0, importedOperations: 0 });
});

describe("host learned lifecycle RPC", () => {
  it("is callable by the host but is not advertised to model tool selection", async () => {
    expect(memoryGovernanceToolSchemas.some((schema) => String(schema.name) === "memory_learned_revert")).toBe(false);
    const result = await handleMemoryGovernanceTool(
      "memory_learned_revert",
      { itemId: "lrn_0123456789abcdef01", reason: "The tool contract changed" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(result)).toEqual({
      found: true,
      recordId: "rec-1",
      itemId: "lrn_0123456789abcdef01",
      status: "reverted",
      centralStatus: "archived",
    });
    expect(mocks.revert).toHaveBeenCalledWith(
      "user-a",
      "org-a",
      "lrn_0123456789abcdef01",
      "The tool contract changed",
    );
  });

  it("requires server-bound organization context and rejects tenancy arguments", async () => {
    await expect(handleMemoryGovernanceTool(
      "memory_learned_revert",
      { itemId: "lrn_0123456789abcdef01", reason: "No longer valid" },
      { defaultUserId: "user-a" },
    )).rejects.toThrow(/organization context is required/);
    await expect(handleMemoryGovernanceTool(
      "memory_learned_revert",
      {
        itemId: "lrn_0123456789abcdef01",
        reason: "No longer valid",
        userId: "user-b",
        orgId: "org-b",
      },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    )).rejects.toThrow();
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("mirrors a validated projection through an unadvertised tenant-bound RPC", async () => {
    expect(memoryGovernanceToolSchemas.some((schema) => String(schema.name) === "memory_learned_sync")).toBe(false);
    const learned = {
      schemaVersion: 1,
      itemId: "lrn_0123456789abcdef01",
      tier: "evidence",
      origin: "model-inferred",
      form: "lesson",
      status: "active",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T01:00:00.000Z",
      falsifier: "The check no longer catches the failure.",
      expectation: "Fewer repeated failures.",
      provenance: {
        sessionKey: "session-a",
        capturedAt: "2026-08-09T00:00:00.000Z",
        checkpoint: "turn-end",
        evidence: ["The failure repeated."],
        sawUntrustedContent: false,
        gateReasoning: "Repeated and falsifiable.",
      },
      outcome: { retrievals: 2, confirmations: 1, contradictions: 0 },
    };
    const result = await handleMemoryGovernanceTool(
      "memory_learned_sync",
      { recordId: "rec-1", itemId: learned.itemId, learned },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(result)).toMatchObject({ found: true, applied: true, blockedByHumanRevert: false });
    expect(mocks.sync).toHaveBeenCalledWith(
      "user-a", "org-a", "rec-1", learned.itemId, learned,
    );
  });

  it("accepts human-correction evidence after one-way instruction demotion", async () => {
    const learned = {
      schemaVersion: 1,
      itemId: "lrn_0123456789abcdef01",
      tier: "evidence",
      origin: "human-correction",
      form: "lesson",
      status: "active",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T01:00:00.000Z",
      falsifier: "The correction no longer improves the result.",
      expectation: "The corrected workflow remains reliable.",
      provenance: {
        sessionKey: "session-a",
        capturedAt: "2026-08-09T00:00:00.000Z",
        checkpoint: "turn-end",
        evidence: ["The correction was explicitly supplied."],
        sawUntrustedContent: false,
        gateReasoning: "Human correction demoted after retirement review.",
      },
      outcome: { retrievals: 2, confirmations: 0, contradictions: 0 },
    } as const;

    await handleMemoryGovernanceTool(
      "memory_learned_sync",
      { recordId: "rec-1", itemId: learned.itemId, learned },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );

    expect(mocks.sync).toHaveBeenCalledWith(
      "user-a", "org-a", "rec-1", learned.itemId, learned,
    );
  });

  it("still rejects model-inferred instruction authority", async () => {
    await expect(handleMemoryGovernanceTool(
      "memory_learned_sync",
      {
        recordId: "rec-1",
        itemId: "lrn_0123456789abcdef01",
        learned: {
          schemaVersion: 1,
          itemId: "lrn_0123456789abcdef01",
          tier: "instruction",
          origin: "model-inferred",
          form: "lesson",
          status: "active",
          createdAt: "2026-08-09T00:00:00.000Z",
          updatedAt: "2026-08-09T01:00:00.000Z",
          falsifier: "The inferred instruction produces a contrary result.",
          expectation: "Model inference never gains instruction authority.",
          provenance: {
            sessionKey: "session-a",
            capturedAt: "2026-08-09T00:00:00.000Z",
            checkpoint: "turn-end",
            evidence: ["The model inferred this behavior."],
            sawUntrustedContent: false,
            gateReasoning: "Model inference remains evidence only.",
          },
          outcome: { retrievals: 0, confirmations: 0, contradictions: 0 },
        },
      },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    )).rejects.toThrow(/tier does not match its origin authority/);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns only the exact server-pinned learning identity", async () => {
    expect(memoryGovernanceToolSchemas.some((schema) => String(schema.name) === "memory_learning_identity")).toBe(false);
    const result = await handleHostLearningRequest(
      { operation: "identity" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(result)).toEqual({ userId: "user-a", orgId: "org-a" });
    await expect(handleHostLearningRequest(
      { operation: "identity", input: { userId: "user-b" } },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    )).rejects.toThrow();
  });

  it("inspects and transitions lifecycle only through the pinned tenant and item", async () => {
    expect(memoryGovernanceToolSchemas.some((schema) => String(schema.name) === "memory_learned_lifecycle")).toBe(false);
    const itemId = "lrn_0123456789abcdef01";
    const inspected = await handleMemoryGovernanceTool(
      "memory_learned_lifecycle",
      { operation: "inspect", recordId: "rec-1", itemId },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(inspected)).toEqual({
      found: true,
      recordId: "rec-1",
      itemId,
      learnedStatus: "active",
      memoryStatus: "active",
      applied: false,
      blockedByHumanRevert: false,
    });
    expect(mocks.inspect).toHaveBeenCalledWith("user-a", "org-a", "rec-1", itemId);

    await handleMemoryGovernanceTool(
      "memory_learned_lifecycle",
      { operation: "archive", recordId: "rec-1", itemId, reason: "capacity retirement" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(mocks.transition).toHaveBeenCalledWith(
      "user-a", "org-a", "rec-1", itemId, "archive", "capacity retirement",
    );
  });

  it("makes learned records unavailable through generic owner-only get and update", async () => {
    mocks.get.mockResolvedValue({
      memory: {
        id: "rec-other-org",
        userId: "user-a",
        orgId: "org-b",
        metadata: { learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01" } },
      },
      evidence: [],
    });
    const got = await handleMemoryGovernanceTool(
      "memory_get",
      { recordId: "rec-other-org" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(got)).toBeNull();

    const updated = await handleMemoryGovernanceTool(
      "memory_update",
      { recordId: "rec-other-org", status: "archived" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    expect(resultJson(updated)).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("blocks generic evidence and hard-delete operations for a learned record", async () => {
    mocks.get.mockResolvedValue({
      memory: {
        id: "rec-learned",
        metadata: { learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01" } },
      },
      evidence: [],
    });

    const added = await handleMemoryGovernanceTool(
      "memory_evidence_add",
      { recordId: "rec-learned", kind: "test", ref: "focused check" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    const evidence = await handleMemoryGovernanceTool(
      "memory_evidence_get",
      { recordId: "rec-learned" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );
    const deleted = await handleMemoryGovernanceTool(
      "memory_governance_delete",
      { recordId: "rec-learned", reason: "remove it" },
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    );

    expect(resultJson(added)).toBeNull();
    expect(resultJson(evidence)).toBeNull();
    expect(resultJson(deleted)).toBeNull();
    expect(mocks.addEvidence).not.toHaveBeenCalled();
    expect(mocks.getEvidence).not.toHaveBeenCalled();
    expect(mocks.governanceDelete).not.toHaveBeenCalled();
  });

  it("filters learned records and their evidence/audit trail from generic export", async () => {
    mocks.exportMemories.mockResolvedValue({
      version: 1,
      exportedAt: "2026-08-09T00:00:00.000Z",
      userId: "user-a",
      memories: [
        { id: "rec-normal", metadata: {} },
        {
          id: "rec-learned",
          metadata: { learned: { schemaVersion: 1, itemId: "lrn_0123456789abcdef01" } },
        },
      ],
      evidence: [
        { id: "ev-normal", recordId: "rec-normal" },
        { id: "ev-learned", recordId: "rec-learned" },
      ],
      operations: [
        { id: "op-normal", recordId: "rec-normal", operation: "memory_update", metadata: {} },
        { id: "op-linked", recordId: "rec-learned", operation: "memory_update", metadata: {} },
        {
          id: "op-learned",
          recordId: null,
          operation: "learned_item_sync",
          metadata: { itemId: "lrn_0123456789abcdef01" },
        },
      ],
    });

    const exported = resultJson(await handleMemoryGovernanceTool(
      "memory_export",
      {},
      { defaultUserId: "user-a", defaultOrgId: "org-a" },
    )) as { memories: Array<{ id: string }>; evidence: Array<{ id: string }>; operations: Array<{ id: string }> };

    expect(exported.memories.map((entry) => entry.id)).toEqual(["rec-normal"]);
    expect(exported.evidence.map((entry) => entry.id)).toEqual(["ev-normal"]);
    expect(exported.operations.map((entry) => entry.id)).toEqual(["op-normal"]);
  });
});
