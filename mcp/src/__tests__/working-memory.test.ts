import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { handleMemoryWorkingTool } from "../tools/memory-working.js";

function parseToolJson(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

describe("short-term working memory tools", () => {
  it("writes refs and updates the Mermaid canvas during a 100-tool-call session", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-"));
    const userId = "user-1";
    const sessionKey = "session-100";

    for (let index = 0; index < 100; index += 1) {
      await handleMemoryWorkingTool("memory_working_offload", {
        workspacePath,
        userId,
        sessionKey,
        payload: `tool output ${index} ${"x".repeat(120)}`,
        title: `Tool call ${index}`,
        summary: `Summary ${index}`,
        kind: "tool_output",
      });
    }

    const workDir = join(workspacePath, ".brainrouter", "work", userId, sessionKey);
    expect(existsSync(join(workDir, "steps.jsonl"))).toBe(true);
    expect(existsSync(join(workDir, "canvas.mmd"))).toBe(true);
    expect(existsSync(join(workDir, "refs"))).toBe(true);
    expect(readFileSync(join(workDir, "canvas.mmd"), "utf8")).toContain("flowchart TD");
  });

  it("returns working context without raw payloads unless a ref is requested", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-context-"));
    const userId = "user-1";
    const sessionKey = "context-session";
    const payload = "raw payload that should stay out of injected state";

    const offload = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload,
      title: "Context payload",
      summary: "Safe summary",
    }));
    const context = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId,
      sessionKey,
    }));

    expect(context.canvas).toContain("flowchart TD");
    expect(JSON.stringify(context.state.injectedState)).not.toContain(payload);
    expect(context.ref).toBeUndefined();

    const withRef = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId,
      sessionKey,
      nodeId: offload.nodeId,
    }));
    expect(withRef.ref.content).toContain(payload);
  });

  it("uses aggressive pressure above 85 percent estimated context fill", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-aggressive-"));
    const userId = "user-1";
    const sessionKey = "aggressive-session";

    const result = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload: "large result",
      title: "Large result",
      contextWindowTokens: 100,
      estimatedTokens: 86,
    }));

    expect(result.pressureLevel).toBe("aggressive");
    expect(result.state.injectedState.rawPayloadsIncluded).toBe(false);
  });

  it("returns an annotated canvas with the active working node highlighted", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-annotated-"));
    const userId = "user-1";
    const sessionKey = "annotated-session";

    const offload = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload: "active payload",
      title: "Active payload",
      summary: "Highlighted summary",
    }));

    const context = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId,
      sessionKey,
      activeNodeId: offload.nodeId,
    }));

    expect(context.canvas).toContain(`style ${offload.nodeId} fill:#2b6cb0`);
    expect(context.canvas).toContain("🌟 Active payload");
    expect(context.annotatedCanvas).toBe(context.canvas);
  });

  it("partitions working memory files by user ID", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-users-"));
    const sessionKey = "shared-session";

    await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId: "user-a",
      sessionKey,
      payload: "payload for user a",
      title: "User A",
    });

    await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId: "user-b",
      sessionKey,
      payload: "payload for user b",
      title: "User B",
    });

    const userAContext = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId: "user-a",
      sessionKey,
    }));
    const userBContext = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId: "user-b",
      sessionKey,
    }));

    expect(userAContext.workDir).toContain(join(".brainrouter", "work", "user-a", sessionKey));
    expect(userBContext.workDir).toContain(join(".brainrouter", "work", "user-b", sessionKey));
    expect(userAContext.canvas).toContain("User A");
    expect(userAContext.canvas).not.toContain("User B");
    expect(userBContext.canvas).toContain("User B");
    expect(userBContext.canvas).not.toContain("User A");
  });

  it("uses the authenticated MCP user when a tool call omits userId", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-default-user-"));
    const sessionKey = "authenticated-session";

    await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      sessionKey,
      payload: "payload for authenticated user",
      title: "Authenticated user",
    }, { defaultUserId: "admin" });

    const adminContext = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      sessionKey,
    }, { defaultUserId: "admin" }));
    const fallbackContext = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      sessionKey,
    }));

    expect(adminContext.workDir).toContain(join(".brainrouter", "work", "admin", sessionKey));
    expect(adminContext.canvas).toContain("Authenticated user");
    expect(fallbackContext.workDir).toContain(join(".brainrouter", "work", "default", sessionKey));
    expect(fallbackContext.canvas).not.toContain("Authenticated user");
  });

  it("routes foreign absolute workspace paths to the user fallback instead of the process cwd", async () => {
    if (process.platform === "win32") return;

    const foreignWorkspacePath = "c:\\Users\\Miu\\Desktop\\Tung\\review paper 1";
    const pollutedPath = resolve(foreignWorkspacePath);
    rmSync(pollutedPath, { recursive: true, force: true });

    const result = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath: foreignWorkspacePath,
      userId: "user-1",
      sessionKey: "foreign-session",
      payload: "foreign path payload",
      title: "Foreign path payload",
    }));

    expect(result.state.workDir).toContain(join(homedir(), ".brainrouter", "work", "user-1"));
    expect(result.state.workDir).not.toContain(foreignWorkspacePath);
    expect(existsSync(join(result.state.workDir, "refs"))).toBe(true);
    expect(existsSync(pollutedPath)).toBe(false);
    rmSync(result.state.workDir, { recursive: true, force: true });
  });

  it("treats listed workspace IDs as fallback-store IDs, not relative paths", async () => {
    const sessionKey = "workspace-id-session";
    const result = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath: "abc123abc123",
      userId: "workspace-id-user",
      sessionKey,
      payload: "payload for listed workspace id",
      title: "Listed workspace id",
    }));

    expect(result.state.workDir).toBe(join(homedir(), ".brainrouter", "work", "workspace-id-user", "abc123abc123", sessionKey));
    expect(existsSync(join(resolve("abc123abc123"), ".brainrouter"))).toBe(false);
    rmSync(result.state.workDir, { recursive: true, force: true });
  });
});
