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
    const [user, query, asOf, pool, org, opts] = mocks.searchAsOf.mock.calls[0]!;
    expect([user, query, asOf, org]).toEqual(["user-a", "focused checks", "2026-08-09T00:00:00.000Z", "org-active"]);
    // A wider pool than the 4 shown, so this workspace's records can take the slots.
    expect(pool).toBeGreaterThanOrEqual(4);
    expect(opts).toEqual({ includeProvenance: true });
    expect(JSON.parse(String((result as any).content[0].text))).toMatchObject({ count: 0, memories: [] });
  });
});

// ---------------------------------------------------------------------------
// Scope, size and limit. Each of these was measured broken before it was
// fixed: the desktop's call threw, `limit` never reached recall, and a
// one-hit answer was 7 KB of system-prompt material.
// ---------------------------------------------------------------------------

const PATH_TAG = "ws_path_hash_000";   // how chat turns in this checkout are tagged
const REPO_TAG = "ws_repo_hash_000";   // how this checkout's ingested files are tagged
const hit = (id: string, extra: Record<string, unknown> = {}) => ({
  content: `record ${id}`, score: 1, type: "fact", recordId: id, ...extra,
});
const parse = (result: any) => JSON.parse(String(result.content[0].text));

describe("memory_search scope, limit and size", () => {
  it("answers a call with no session — the desktop Memory panel sends none", async () => {
    mocks.recall.mockResolvedValue({ recallStrategy: "hybrid", recalledCognitiveMemories: [hit("a")] });
    const result: any = await handleMemorySearch({ query: "auth" });
    expect(result.isError).toBeUndefined();
    expect(parse(result).recalledCognitiveMemories.map((h: any) => h.recordId)).toEqual(["a"]);
    // With no session it must not claim another session's private records.
    expect(mocks.recall).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: "" }));
  });

  it("ranks this session, then EITHER workspace identity, then untagged, then other workspaces", async () => {
    mocks.recall.mockResolvedValue({
      recalledCognitiveMemories: [
        hit("elsewhere", { workspaceTag: "ws_other_repo_00" }),
        hit("ingested", { workspaceTag: REPO_TAG }),
        hit("chat", { workspaceTag: PATH_TAG }),
        hit("legacy", { workspaceTag: null }),
        hit("now", { workspaceTag: PATH_TAG, sessionKey: "s-1" }),
      ],
    });
    const out = parse(await handleMemorySearch({
      query: "q", sessionKey: "s-1", workspaceTags: [PATH_TAG, REPO_TAG],
    }));
    expect(out.recalledCognitiveMemories.map((h: any) => [h.recordId, h.scopeMatch])).toEqual([
      ["now", "session"],
      ["ingested", "workspace"],   // the repo's own files: here, not "another workspace"
      ["chat", "workspace"],
      ["legacy", "untagged"],
      ["elsewhere", "other-workspace"], // last, labelled — never hidden
    ]);
    expect(out.scope).toEqual({ session: 1, workspace: 2, untagged: 1, otherWorkspace: 1 });
  });

  it("honours limit, widens the pool behind it, and defaults to the promised 10", async () => {
    mocks.recall.mockResolvedValue({
      recalledCognitiveMemories: Array.from({ length: 40 }, (_, i) => hit(`r${i}`)),
    });
    const three = parse(await handleMemorySearch({ query: "q", limit: 3 }));
    expect(three.results).toBe(3);
    const asked = mocks.recall.mock.calls.at(-1)![0];
    expect(asked.limitsOverride.topResults).toBeGreaterThan(3); // room to prefer this workspace
    expect(asked.includeProvenance).toBe(true);
    // An org admin's retrieval caps are theirs; a search must not lift them.
    expect(asked.limitsOverride).not.toHaveProperty("ftsLimit");
    expect(asked.limitsOverride).not.toHaveProperty("vecLimit");

    expect(parse(await handleMemorySearch({ query: "q" })).results).toBe(10);
    expect(parse(await handleMemorySearch({ query: "q", limit: 10_000 })).results).toBeLessThanOrEqual(40);
    expect(mocks.recall.mock.calls.at(-1)![0].limitsOverride.topResults).toBeLessThanOrEqual(50);
  });

  it("returns the hits and nothing that belongs in a system prompt", async () => {
    mocks.recall.mockResolvedValue({
      recallStrategy: "hybrid",
      prependContext: "<relevant-memories>…</relevant-memories>",
      appendSystemContext: "## Core identity\n" + "x".repeat(100_000),
      coreIdentitySummary: "y".repeat(20_000),
      recallExplanation: { durationMs: 3 },
      recalledCognitiveMemories: [hit("a", { workspaceTag: PATH_TAG, sessionKey: "s" })],
    });
    const result: any = await handleMemorySearch({ query: "q", workspaceTag: PATH_TAG });
    const out = parse(result);
    for (const key of ["prependContext", "appendSystemContext", "coreIdentitySummary", "recallExplanation"]) {
      expect(out, key).not.toHaveProperty(key);
    }
    // The opaque hashes are replaced by the label a reader can use.
    expect(out.recalledCognitiveMemories[0]).not.toHaveProperty("workspaceTag");
    expect(out.recalledCognitiveMemories[0]).not.toHaveProperty("sessionKey");
    expect(out.recalledCognitiveMemories[0].scopeMatch).toBe("workspace");
    expect(String(result.content[0].text).length).toBeLessThan(1_000);
  });

  it("bounds a single oversized record and says it did", async () => {
    mocks.recall.mockResolvedValue({ recalledCognitiveMemories: [hit("big", { content: "z".repeat(50_000) })] });
    const out = parse(await handleMemorySearch({ query: "q" }));
    const content = out.recalledCognitiveMemories[0].content as string;
    expect(content.length).toBeLessThan(1_300);
    expect(content).toMatch(/\[truncated, 50000 chars\]$/);
  });
});

describe("point-in-time search", () => {
  it("prefers this workspace too, keeps its shape, and stops at the limit", async () => {
    mocks.searchAsOf.mockResolvedValue({
      asOf: "2026-08-09T00:00:00.000Z",
      count: 4,
      memories: [
        hit("then-elsewhere", { workspaceTag: "ws_other_repo_00" }),
        hit("then-ingested", { workspaceTag: REPO_TAG }),
        hit("then-here", { workspaceTag: PATH_TAG }),
        hit("then-legacy", { workspaceTag: null }),
      ],
    });
    const out = parse(await handleMemorySearch({
      query: "q", asOf: "2026-08-09T00:00:00.000Z", limit: 3, workspaceTags: [PATH_TAG, REPO_TAG],
    }));
    expect(out.asOf).toBe("2026-08-09T00:00:00.000Z");
    expect(out.count).toBe(3);
    expect(out.memories.map((m: any) => [m.recordId, m.scopeMatch])).toEqual([
      ["then-ingested", "workspace"],
      ["then-here", "workspace"],
      ["then-legacy", "untagged"],
    ]);
    expect(out.memories[0]).not.toHaveProperty("workspaceTag");
  });
});
