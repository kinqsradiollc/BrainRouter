/**
 * ADR-015 P1c — the capture scope tag prefers repo identity over the path hash.
 */
import { describe, it, expect } from "vitest";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";
import { repoTag } from "@kinqs/brainrouter-core/track";
import { repoScopedWorkspaceTag } from "./repoScope.js";

describe("repoScopedWorkspaceTag (ADR-015 P1c)", () => {
  it("prefers a non-empty repoTag over the workspace path hash", () => {
    const tag = "0123456789abcdef";
    const scope = repoScopedWorkspaceTag(tag, "/some/local/checkout");
    expect(scope).toBe(tag);
    // The repo tag is chosen even though the path would hash to something else.
    expect(scope).not.toBe(workspaceTagFromPath("/some/local/checkout"));
  });

  it("scopes two different folders of the same repo to one tag (survives a move)", () => {
    const tag = "feedfacecafebabe";
    expect(repoScopedWorkspaceTag(tag, "/home/a/proj")).toBe(
      repoScopedWorkspaceTag(tag, "/tmp/second-clone/proj"),
    );
    // ...whereas the path hashes differ, which is exactly the drift P1c fixes.
    expect(workspaceTagFromPath("/home/a/proj")).not.toBe(
      workspaceTagFromPath("/tmp/second-clone/proj"),
    );
  });

  it("falls back to the path hash for a non-git workspace (empty/whitespace repoTag)", () => {
    const expected = workspaceTagFromPath("/plain/folder");
    expect(repoScopedWorkspaceTag(undefined, "/plain/folder")).toBe(expected);
    expect(repoScopedWorkspaceTag("", "/plain/folder")).toBe(expected);
    expect(repoScopedWorkspaceTag("   ", "/plain/folder")).toBe(expected);
    expect(repoScopedWorkspaceTag(null, "/plain/folder")).toBe(expected);
  });

  it("returns null (unscoped, NULL-tolerant) when neither identity is present", () => {
    expect(repoScopedWorkspaceTag(undefined, undefined)).toBeNull();
    expect(repoScopedWorkspaceTag("", null)).toBeNull();
  });

  it("agrees with the repo-file ingest path: a remote URL hashes to the same scope", () => {
    // ingestRepo scopes files by repoTag(remoteUrl); capture, given the same tag,
    // lands turns in the same bucket so a repo's files and transcripts recall together.
    const tag = repoTag("git@github.com:kinqsradio/brainrouter.git");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(repoScopedWorkspaceTag(tag, "/anywhere")).toBe(tag);
    // http and ssh forms of the same repo normalize to one tag.
    expect(tag).toBe(repoTag("https://github.com/kinqsradio/brainrouter"));
  });
});
