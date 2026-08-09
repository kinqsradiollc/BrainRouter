import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recall: vi.fn(), searchAsOf: vi.fn() }));

vi.mock("../../memory/engine.js", () => ({
  memoryEngine: {
    recall: mocks.recall,
    searchAsOf: mocks.searchAsOf,
  },
}));

import { handleMemorySearch } from "./memory_search.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recall.mockResolvedValue({ memories: [] });
  mocks.searchAsOf.mockResolvedValue({ memories: [], count: 0, asOf: "2026-08-09T00:00:00.000Z" });
});

describe("memory_search tenant binding", () => {
  it("uses the authenticated user and pinned active org without a default-org lookup", async () => {
    await handleMemorySearch(
      { userId: "spoofed-user", query: "focused checks", sessionKey: "session-a" },
      { defaultUserId: "user-a", defaultOrgId: "org-active" },
    );
    expect(mocks.recall).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-a",
      filters: { orgId: "org-active" },
    }));
  });

  it("passes the pinned org to point-in-time search and awaits its result", async () => {
    const result = await handleMemorySearch(
      {
        query: "focused checks",
        sessionKey: "session-a",
        asOf: "2026-08-09T00:00:00.000Z",
        limit: 4,
      },
      { defaultUserId: "user-a", defaultOrgId: "org-active" },
    );
    expect(mocks.searchAsOf).toHaveBeenCalledWith(
      "user-a", "focused checks", "2026-08-09T00:00:00.000Z", 4, "org-active",
    );
    expect(JSON.parse(String((result as any).content[0].text))).toMatchObject({ count: 0, memories: [] });
  });
});
