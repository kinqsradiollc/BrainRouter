import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { createClientRootsScope, tagsFromRoots, withClientRootsScope } from "./clientRoots.js";

const PROJECT = "/Users/someone/code/widget";
const root = (path: string) => ({ uri: pathToFileURL(path).href, name: "widget" });

describe("tagsFromRoots", () => {
  it("hashes a file root exactly as the CLI hashes the same folder", () => {
    // Otherwise a record captured by the CLI in this checkout and a search
    // from another agent in the same checkout would disagree on "here".
    expect(tagsFromRoots([root(PROJECT)])).toEqual([workspaceTagFromPath(PROJECT)]);
  });

  it("ignores roots that name no local folder, and duplicates", () => {
    expect(tagsFromRoots([
      { uri: "https://example.com/repo" },
      { uri: "not a uri" },
      { uri: 42 },
      root(PROJECT),
      root(PROJECT),
    ])).toEqual([workspaceTagFromPath(PROJECT)]);
  });

  it("never returns more identities than the memory tools accept", () => {
    const many = Array.from({ length: 20 }, (_, i) => root(`/code/repo-${i}`));
    expect(tagsFromRoots(many)).toHaveLength(8);
  });
});

describe("createClientRootsScope", () => {
  it("asks once per connection, then remembers", async () => {
    const fetchRoots = vi.fn(async () => [root(PROJECT)]);
    const scope = createClientRootsScope(fetchRoots, () => true);
    await scope.tags();
    await scope.tags();
    await scope.tags();
    expect(fetchRoots).toHaveBeenCalledTimes(1);
  });

  it("asks again after the client says its roots changed", async () => {
    const fetchRoots = vi.fn(async () => [root(PROJECT)]);
    const scope = createClientRootsScope(fetchRoots, () => true);
    await scope.tags();
    scope.invalidate();
    await scope.tags();
    expect(fetchRoots).toHaveBeenCalledTimes(2);
  });

  it("never asks a client that did not declare roots", async () => {
    const fetchRoots = vi.fn(async () => [root(PROJECT)]);
    const scope = createClientRootsScope(fetchRoots, () => false);
    expect(await scope.tags()).toEqual([]);
    expect(fetchRoots).not.toHaveBeenCalled();
  });

  it("a client that fails or times out costs one attempt, not one per memory call", async () => {
    const fetchRoots = vi.fn(async () => { throw new Error("Request timed out"); });
    const scope = createClientRootsScope(fetchRoots, () => true);
    expect(await scope.tags()).toEqual([]);
    expect(await scope.tags()).toEqual([]);
    expect(fetchRoots).toHaveBeenCalledTimes(1);
  });
});

describe("withClientRootsScope", () => {
  const scope = { tags: vi.fn(async () => [workspaceTagFromPath(PROJECT)!]) };

  it("adds the client's workspace to a memory read that brought none", async () => {
    for (const tool of ["memory_search", "memory_recall"]) {
      const out = await withClientRootsScope(tool, { query: "q", sessionKey: "s" }, scope) as Record<string, unknown>;
      expect(out.workspaceTags).toEqual([workspaceTagFromPath(PROJECT)]);
      expect(out.query).toBe("q");
    }
  });

  it("leaves a caller that sent its own scope alone — it knows better", async () => {
    const args = { query: "q", workspaceTags: ["folder", "repo"] };
    expect(await withClientRootsScope("memory_search", args, scope)).toBe(args);
  });

  it("touches no other tool, and does not even ask for roots for one", async () => {
    const asking = { tags: vi.fn(async () => ["x"]) };
    const args = { query: "q" };
    expect(await withClientRootsScope("memory_capture_turn", args, asking)).toBe(args);
    expect(await withClientRootsScope("list_skills", args, asking)).toBe(args);
    expect(asking.tags).not.toHaveBeenCalled();
  });

  it("with no roots the call is exactly what the client sent", async () => {
    const args = { query: "q" };
    expect(await withClientRootsScope("memory_search", args, { tags: async () => [] })).toBe(args);
  });
});
