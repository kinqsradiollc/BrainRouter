import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { CognitiveRecord } from "@kinqs/brainrouter-types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getByItemId: vi.fn(),
  recordLesson: vi.fn(),
  revert: vi.fn(),
}));

vi.mock("../../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      listHostedLearnedRecords: mocks.list,
      getHostedLearnedRecordByItemId: mocks.getByItemId,
      revertHostedLearnedRecord: mocks.revert,
    },
    recordLesson: mocks.recordLesson,
  },
}));
vi.mock("../middleware/auth.js", () => ({
  requireActiveAnyAuth: (req: any, _res: any, next: () => void) => {
    req.userId = "user-a";
    next();
  },
}));
vi.mock("../middleware/tenancy.js", () => ({
  attachOrgContext: async (req: any) => {
    req.orgId = "org-a";
    req.role = "developer";
    return true;
  },
}));

import { learnedBehaviorsRouter } from "./learnedBehaviors.js";

function learnedRecord(overrides: Partial<CognitiveRecord> = {}): CognitiveRecord {
  return {
    id: "cognitive_lesson_1",
    userId: "user-a",
    orgId: "org-a",
    sessionKey: "session-1",
    sessionId: "session-1",
    content: "Run the focused typecheck before handing off.",
    type: "lesson",
    priority: 80,
    sceneName: "",
    skillTag: "",
    halfLifeDays: null,
    supersededBy: null,
    timestampStr: "",
    timestampStart: "",
    timestampEnd: "",
    createdTime: "2026-08-09T01:00:00.000Z",
    updatedTime: "2026-08-09T01:02:00.000Z",
    metadata: {
      learned: {
        schemaVersion: 1,
        itemId: "lrn_0123456789abcdef01",
        tier: "evidence",
        origin: "model-inferred",
        form: "procedure",
        status: "active",
        statusReason: "gate admitted",
        statusChangedAt: "2026-08-09T01:00:00.000Z",
        createdAt: "2026-08-09T01:00:00.000Z",
        updatedAt: "2026-08-09T01:02:00.000Z",
        falsifier: "The focused typecheck does not cover the changed package.",
        expectation: "Handoffs contain fewer type failures.",
        skillId: "learned-focused-typecheck",
        allowedTools: ["read_file"],
        provenance: {
          sessionKey: "session-1",
          capturedAt: "2026-08-09T01:00:00.000Z",
          checkpoint: "turn-end",
          evidence: ["A type error was found after the handoff."],
          corroboratingActionIds: ["action-1"],
          sawUntrustedContent: false,
          gateReasoning: "Repeated and falsifiable.",
        },
        outcome: { retrievals: 3, confirmations: 2, contradictions: 0 },
        memoryLifecycle: { status: "active", updatedAt: "2026-08-09T01:02:00.000Z", attempts: 1 },
      },
    },
    confidence: 0.8,
    status: "active",
    sourceKind: "user_instruction",
    verificationStatus: "",
    repoPaths: [],
    filePaths: [],
    commands: [],
    citationCount: 0,
    lastCitedAt: null,
    neverCitedCount: 0,
    archived: false,
    ...overrides,
  };
}

let server: Server | undefined;
let baseUrl = "";

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([learnedRecord()]);
  mocks.getByItemId.mockResolvedValue(learnedRecord());
  mocks.recordLesson.mockResolvedValue({
    recordId: "cognitive_lesson_1",
    reinforced: false,
    confidence: 0.8,
    corroborations: 1,
    supersededIds: [],
  });
  mocks.revert.mockImplementation(async (_userId, _orgId, _itemId, reason) => learnedRecord({
    status: "archived",
    archived: true,
    metadata: {
      learned: {
        ...(learnedRecord().metadata.learned as Record<string, unknown>),
        status: "reverted",
        statusReason: reason,
      },
    },
  }));
  const app = express();
  app.use(express.json());
  app.use("/api/learned-behaviors", learnedBehaviorsRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/learned-behaviors`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
});

describe("hosted learned behaviour API", () => {
  it("lists central metadata with provenance and counters in the active tenant only", async () => {
    mocks.list.mockResolvedValue([
      learnedRecord(),
      learnedRecord({ id: "other-org", orgId: "org-b" }),
      learnedRecord({ id: "other-user", userId: "user-b" }),
    ]);
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      source: "hosted-memory",
      deviceLedgerIncluded: false,
      truncated: false,
      items: [{
        id: "lrn_0123456789abcdef01",
        outcome: { retrievals: 3, confirmations: 2, contradictions: 0 },
        provenance: { sessionKey: "session-1", gateReasoning: "Repeated and falsifiable." },
      }],
    });
    expect(body.items).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledWith("user-a", "org-a", 201);
  });

  it("keeps demoted human evidence visible but rejects model-inferred instruction authority", async () => {
    const baseLearned = learnedRecord().metadata.learned as Record<string, unknown>;
    mocks.list.mockResolvedValue([
      learnedRecord({
        id: "human-evidence",
        metadata: { learned: { ...baseLearned, tier: "evidence", origin: "human-correction" } },
      }),
      learnedRecord({
        id: "model-instruction",
        metadata: { learned: { ...baseLearned, tier: "instruction", origin: "model-inferred" } },
      }),
    ]);

    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      recordId: "human-evidence",
      tier: "evidence",
      origin: "human-correction",
    });
  });

  it("requires a specific reason before mutating", async () => {
    const response = await fetch(`${baseUrl}/lrn_0123456789abcdef01/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.revert).not.toHaveBeenCalled();
  });

  it("records a structured authenticated correction as instruction-tier central memory", async () => {
    const correction = learnedRecord({
      content: "Use a merge commit for every release branch integration.",
      metadata: {
        learned: {
          ...(learnedRecord().metadata.learned as Record<string, unknown>),
          itemId: "lrn_a123456789abcdef01",
          tier: "instruction",
          origin: "human-correction",
          form: "lesson",
          falsifier: "a squash merge preserves the release branch ancestry",
          expectation: "release ancestry remains visible after integration",
        },
      },
    });
    mocks.getByItemId.mockImplementation(async (_userId, _orgId, itemId) => learnedRecord({
      ...correction,
      metadata: {
        learned: {
          ...(correction.metadata.learned as Record<string, unknown>),
          itemId,
        },
      },
    }));

    const response = await fetch(`${baseUrl}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: "chat-42",
        statement: "Use a merge commit for every release branch integration.",
        falsifier: "a squash merge preserves the release branch ancestry",
        expectation: "release ancestry remains visible after integration",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      source: "authenticated-human-correction",
      reinforced: false,
      item: { tier: "instruction", origin: "human-correction" },
    });
    expect(mocks.recordLesson).toHaveBeenCalledWith(
      "user-a",
      "Use a merge commit for every release branch integration.",
      expect.objectContaining({
        orgId: "org-a",
        kind: "learned-human-correction",
        sessionKey: expect.stringMatching(/^hosted-correction:[a-f0-9]{32}$/),
        learned: expect.objectContaining({ tier: "instruction", origin: "human-correction" }),
      }),
    );
  });

  it("rejects correction-shaped prose that is not falsifiable", async () => {
    const response = await fetch(`${baseUrl}/correct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: "chat-42",
        statement: "Be more careful with releases.",
        falsifier: "it goes wrong",
        expectation: "fewer mistakes",
      }),
    });
    expect(response.status).toBe(422);
    expect(mocks.recordLesson).not.toHaveBeenCalled();
  });

  it("reverts by authenticated user and active org and reports device reconciliation honestly", async () => {
    const response = await fetch(`${baseUrl}/lrn_0123456789abcdef01/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "The tool contract changed" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item: { status: "reverted", statusReason: "The tool contract changed" },
      reconciliation: "central-reverted",
      deviceReconciliation: "next-learning-checkpoint",
    });
    expect(mocks.revert).toHaveBeenCalledWith(
      "user-a",
      "org-a",
      "lrn_0123456789abcdef01",
      "The tool contract changed",
    );
  });

  it("does not reveal whether a returned record belongs to another tenant", async () => {
    mocks.revert.mockResolvedValue(learnedRecord({ orgId: "org-b" }));
    const response = await fetch(`${baseUrl}/lrn_0123456789abcdef01/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "No longer valid" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Learned item not found" });
  });
});
