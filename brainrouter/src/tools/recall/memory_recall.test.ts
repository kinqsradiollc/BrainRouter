import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recall: vi.fn(), spikeSkill: vi.fn() }));
vi.mock("../../memory/engine.js", () => ({
  memoryEngine: { recall: mocks.recall, spikeSkill: mocks.spikeSkill },
}));

import { handleMemoryRecall } from "./memory_recall.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recall.mockResolvedValue({ recallStrategy: "hybrid", recalledCognitiveMemories: [] });
});

describe("memory_recall caller scope", () => {
  it("turns workspaceTags into a PREFERENCE, never a filter", async () => {
    await handleMemoryRecall({ sessionKey: "s-1", query: "q", workspaceTags: ["ws_folder", "ws_repo"] });
    const call = mocks.recall.mock.calls[0]![0];
    expect(call.preferScope).toEqual({ sessionKey: "s-1", workspaceTags: ["ws_folder", "ws_repo"] });
    // A preference must not quietly become the hard filter that drops records.
    expect(call.filters?.workspaceTag).toBeUndefined();
    expect(call.filters?.workspaceTags).toBeUndefined();
  });

  it("leaves a caller that sends no scope exactly as it was", async () => {
    await handleMemoryRecall({ sessionKey: "s-1", query: "q" });
    expect(mocks.recall.mock.calls[0]![0]).not.toHaveProperty("preferScope");
  });

  it("keeps the explicit hard filter working, separately", async () => {
    await handleMemoryRecall({ sessionKey: "s-1", query: "q", filters: { workspaceTag: "ws_folder" } });
    expect(mocks.recall.mock.calls[0]![0].filters.workspaceTag).toBe("ws_folder");
  });

  it("still server-pins the org and drops a client-supplied one", async () => {
    await handleMemoryRecall(
      { sessionKey: "s-1", query: "q", workspaceTags: ["ws_folder"], filters: { orgId: "evil-org" } },
      { defaultUserId: "u", defaultOrgId: "org-real" },
    );
    expect(mocks.recall.mock.calls[0]![0].filters.orgId).toBe("org-real");
  });
});
