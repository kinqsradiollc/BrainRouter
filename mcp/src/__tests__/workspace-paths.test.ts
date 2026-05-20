import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSafeWorkspacePath, isForeignAbsolutePath } from "../resolver.js";
import { handleMemoryResolveSession } from "../tools/memory_resolve_session.js";

function parseToolJson(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe("workspace path compatibility", () => {
  it("detects Windows absolute paths as foreign on POSIX hosts", () => {
    expect(isForeignAbsolutePath("c:\\Users\\Miu\\Desktop\\Tung\\review paper 1")).toBe(process.platform !== "win32");
  });

  it("uses a fallback workspace for foreign absolute paths", () => {
    const foreignWorkspacePath = "c:\\Users\\Miu\\Desktop\\Tung\\review paper 1";

    const safePath = getSafeWorkspacePath(foreignWorkspacePath);

    if (process.platform === "win32") {
      expect(safePath).toBe(resolve(foreignWorkspacePath));
    } else {
      expect(safePath).toContain(join(homedir(), ".brainrouter", "fallback-workspaces"));
      expect(safePath).not.toContain(foreignWorkspacePath);
    }
  });

  it("caches resolved sessions under the safe fallback for foreign absolute paths", async () => {
    if (process.platform === "win32") return;

    const foreignWorkspacePath = "c:\\Users\\Miu\\Desktop\\Tung\\review paper 1";
    const pollutedPath = resolve(foreignWorkspacePath);
    const safePath = getSafeWorkspacePath(foreignWorkspacePath);
    rmSync(pollutedPath, { recursive: true, force: true });
    rmSync(safePath, { recursive: true, force: true });

    const result = parseToolJson(await handleMemoryResolveSession({
      workspacePath: foreignWorkspacePath,
    }));

    const cacheFile = join(safePath, ".brainrouter", "active_session.json");
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));

    expect(result.source).toBe("new_workspace_generation");
    expect(cached.sessionKey).toBe(result.sessionKey);
    expect(cached.workspace).toBe(foreignWorkspacePath);
    expect(cached.cacheWorkspace).toBe(safePath);
    expect(existsSync(pollutedPath)).toBe(false);
    rmSync(safePath, { recursive: true, force: true });
  });
});
