import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBrainrouterHome } from "../brainrouter-home.js";
import { getSafeWorkspacePath, isForeignAbsolutePath } from "../resolver.js";
import { getMemoryConsolidationDir, resolveConsolidationWorkspace } from "../tools/sources/memory_consolidate_paths.js";
import { handleMemoryResolveSession } from "../tools/sessions/memory_resolve_session.js";

function mcpCacheFile(workspacePath: string, name: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
  return join(brainrouterHome(), "mcp-cache", hash, name);
}

function parseToolJson(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

function workspaceStateRoot(workspacePath: string): string {
  const abs = realpathSync(workspacePath);
  const base = abs.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]+/g, "_") || "root";
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return join(brainrouterHome(), "workspaces", `${base.slice(0, 60)}-${hash}`);
}

function brainrouterHome(): string {
  return getBrainrouterHome();
}

let previousBrainrouterHome: string | undefined;
let testBrainrouterHome: string | undefined;

beforeEach(() => {
  previousBrainrouterHome = process.env.BRAINROUTER_HOME;
  testBrainrouterHome = mkdtempSync(join(tmpdir(), "brainrouter-home-"));
  process.env.BRAINROUTER_HOME = testBrainrouterHome;
});

afterEach(() => {
  if (previousBrainrouterHome === undefined) delete process.env.BRAINROUTER_HOME;
  else process.env.BRAINROUTER_HOME = previousBrainrouterHome;
  if (testBrainrouterHome) rmSync(testBrainrouterHome, { recursive: true, force: true });
  previousBrainrouterHome = undefined;
  testBrainrouterHome = undefined;
});

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
      expect(safePath).toContain(join(brainrouterHome(), "fallback-workspaces"));
      expect(safePath).not.toContain(foreignWorkspacePath);
    }
  });

  it("caches resolved sessions under the user-home MCP cache for foreign absolute paths", async () => {
    if (process.platform === "win32") return;

    const foreignWorkspacePath = "c:\\Users\\Miu\\Desktop\\Tung\\review paper 1";
    const pollutedPath = resolve(foreignWorkspacePath);
    const safePath = getSafeWorkspacePath(foreignWorkspacePath);
    const cacheFile = mcpCacheFile(safePath, "active_session.json");
    rmSync(pollutedPath, { recursive: true, force: true });
    rmSync(safePath, { recursive: true, force: true });
    rmSync(cacheFile, { force: true });

    const result = parseToolJson(await handleMemoryResolveSession({
      workspacePath: foreignWorkspacePath,
    }));

    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));

    expect(result.source).toBe("new_workspace_generation");
    expect(cached.sessionKey).toBe(result.sessionKey);
    expect(cached.workspace).toBe(foreignWorkspacePath);
    expect(cached.cacheWorkspace).toBe(safePath);
    // Critical regression guard: neither the polluted Windows-style path
    // NOR the safe fallback workspace should have a `.brainrouter/` shell
    // created inside it. The cache lives entirely under `~/.brainrouter/`.
    expect(existsSync(pollutedPath)).toBe(false);
    expect(existsSync(join(safePath, ".brainrouter"))).toBe(false);
    rmSync(safePath, { recursive: true, force: true });
    rmSync(cacheFile, { force: true });
  });

  it("resolves MCP memory consolidation into the user-home workspace bucket", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brainrouter-consolidate-workspace-"));
    const stateRoot = workspaceStateRoot(workspace);
    rmSync(stateRoot, { recursive: true, force: true });

    const workspaceRoot = resolveConsolidationWorkspace(workspace);
    const dir = getMemoryConsolidationDir(workspaceRoot);

    expect(workspaceRoot).toBe(resolve(workspace));
    expect(dir).toBe(join(stateRoot, "memories"));
    expect(existsSync(join(workspace, ".brainrouter", "memories"))).toBe(false);
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects transient BrainRouter work directories for MCP consolidation", () => {
    const transientWorkspace = join(brainrouterHome(), "work", "admin", "abc123", "session-1");
    rmSync(join(transientWorkspace, ".brainrouter"), { recursive: true, force: true });

    expect(() => resolveConsolidationWorkspace(transientWorkspace)).toThrow(/transient working memory/);
    expect(existsSync(join(transientWorkspace, ".brainrouter", "memories"))).toBe(false);
  });
});
