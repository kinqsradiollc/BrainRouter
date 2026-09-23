/**
 * `includeProvenance` — each recalled memory says which workspace and session
 * it came from, so a search can rank the caller's own repository first
 * without filtering anything out. The FTS table does not carry the workspace
 * tag, so it comes from one batched lookup; that lookup must stay off the
 * default path, which is every briefing on every turn.
 */
import { describe, expect, it, vi } from "vitest";
import type { CognitiveFtsResult } from "@kinqs/brainrouter-types";
import { MemoryRecallPipeline } from "../memory/recall/pipeline.js";

function fts(record_id: string, session_key: string): CognitiveFtsResult {
  return {
    record_id,
    user_id: "u1",
    content: `the auth module uses ${record_id}`,
    type: "codebase_fact",
    priority: 50,
    scene_name: null,
    skill_tag: null,
    session_key,
    created_time: "2026-09-01T00:00:00.000Z",
    rank: -1,
  } as unknown as CognitiveFtsResult;
}

/** A store that answers anything the test did not spell out, harmlessly. */
function storeWith(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === "then") return undefined; // not a thenable
      return async () => (String(prop).startsWith("get") && String(prop).endsWith("ByRecordIds") ? new Map() : []);
    },
  });
}

async function recallWith(includeProvenance: boolean) {
  const lookup = vi.fn(async () => new Map<string, string | null>([["rec-a", "ws_repo_hash_000"], ["rec-b", null]]));
  const store = storeWith({
    searchCognitiveFts: async () => [fts("rec-a", "s-1"), fts("rec-b", "s-2")],
    searchCognitiveVec: async () => [],
    getMemoriesByFilePath: async () => [],
    getWorkspaceTagsByRecordIds: lookup,
    getRecordsMaxChurn: async () => new Map(),
  });
  const pipeline = new MemoryRecallPipeline(
    store as never,
    { isReady: () => false, embed: async () => new Float32Array([0]) } as never,
    { isAvailable: () => false } as never,
  );
  const result = await pipeline.recall({
    userId: "u1",
    sessionKey: "s-1",
    query: "auth module",
    ...(includeProvenance ? { includeProvenance: true } : {}),
  });
  return { result, lookup };
}

describe("recall provenance", () => {
  it("attaches the workspace (from the lookup) and session to every hit when asked", async () => {
    const { result, lookup } = await recallWith(true);
    const byId = new Map((result.recalledCognitiveMemories ?? []).map((m) => [m.recordId, m]));
    expect(byId.size).toBeGreaterThan(0);
    expect(lookup).toHaveBeenCalledTimes(1); // one batch, not one query per hit
    expect(byId.get("rec-a")).toMatchObject({ workspaceTag: "ws_repo_hash_000", sessionKey: "s-1" });
    // No tag is information too: it was captured without a workspace.
    expect(byId.get("rec-b")).toMatchObject({ workspaceTag: null, sessionKey: "s-2" });
  });

  it("leaves the default path exactly as it was — no lookup, no new fields", async () => {
    const { result, lookup } = await recallWith(false);
    expect(lookup).not.toHaveBeenCalled();
    // Otherwise the loop below proves nothing.
    expect(result.recalledCognitiveMemories?.length ?? 0).toBeGreaterThan(0);
    for (const memory of result.recalledCognitiveMemories ?? []) {
      expect(memory).not.toHaveProperty("workspaceTag");
      expect(memory).not.toHaveProperty("sessionKey");
    }
  });
});

describe("recall with a caller scope (prefer, never hide)", () => {
  const FOLDER = "ws_folder_hash_0";
  const REPO = "ws_repo_hash_000";

  async function recallScoped(tags: Record<string, string | null>, sessions: Record<string, string>) {
    const ids = Object.keys(tags);
    const store = storeWith({
      searchCognitiveFts: async () => ids.map((id) => fts(id, sessions[id] ?? "s-other")),
      searchCognitiveVec: async () => [],
      getMemoriesByFilePath: async () => [],
      getWorkspaceTagsByRecordIds: async () => new Map(Object.entries(tags)),
      getRecordsMaxChurn: async () => new Map(),
    });
    const pipeline = new MemoryRecallPipeline(
      store as never,
      { isReady: () => false, embed: async () => new Float32Array([0]) } as never,
      { isAvailable: () => false } as never,
    );
    return pipeline.recall({
      userId: "u1",
      sessionKey: "s-1",
      query: "auth module",
      limitsOverride: { topResults: 10 },
      preferScope: { sessionKey: "s-1", workspaceTags: [FOLDER, REPO] },
    });
  }

  it("orders session, then either workspace identity, then untagged, then other — and hides nothing", async () => {
    const result = await recallScoped(
      { "rec-other": "ws_someone_else0", "rec-ingest": REPO, "rec-legacy": null, "rec-chat": FOLDER, "rec-now": FOLDER },
      { "rec-now": "s-1" },
    );
    const got = (result.recalledCognitiveMemories ?? []).map((m) => [m.recordId, m.scopeMatch]);
    expect(got).toHaveLength(5); // every record survives
    const tiers = got.map(([, scope]) => scope);
    const firstOther = tiers.indexOf("other-workspace");
    expect(tiers[0]).toBe("session");
    expect(firstOther).toBe(tiers.length - 1); // other workspaces last
    // The repo's own ingested file is "workspace", not "another workspace".
    expect(Object.fromEntries(got)["rec-ingest"]).toBe("workspace");
  });

  it("tells the model which lines came from another workspace", async () => {
    const result = await recallScoped({ "rec-here": FOLDER, "rec-there": "ws_someone_else0" }, {});
    const lines = (result.prependContext ?? "").split("\n").filter((l) => l.includes("the auth module uses"));
    expect(lines.find((l) => l.includes("rec-there"))).toMatch(/\(another workspace\)/);
    expect(lines.find((l) => l.includes("rec-here"))).not.toMatch(/another workspace/);
  });
});
