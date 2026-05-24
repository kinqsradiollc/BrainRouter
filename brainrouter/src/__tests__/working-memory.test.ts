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

    let workDir = "";
    for (let index = 0; index < 100; index += 1) {
      const offload = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
        workspacePath,
        userId,
        sessionKey,
        payload: `tool output ${index} ${"x".repeat(120)}`,
        title: `Tool call ${index}`,
        summary: `Summary ${index}`,
        kind: "tool_output",
      }));
      workDir = offload.state.workDir;
    }

    // Working memory now lives under the user home — never inside the
    // workspace tree. The workDir is partitioned by user + workspace-hash
    // + sessionKey.
    expect(workDir.startsWith(join(homedir(), ".brainrouter", "work", userId))).toBe(true);
    expect(workDir.endsWith(sessionKey)).toBe(true);
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

    // workDir layout is `~/.brainrouter/work/<userId>/<workspaceHash>/<sessionKey>`.
    // We anchor on the user partition + session terminator; the workspace
    // hash slot in between is a sha256 of the resolved workspace path.
    expect(userAContext.workDir.startsWith(join(homedir(), ".brainrouter", "work", "user-a"))).toBe(true);
    expect(userAContext.workDir.endsWith(sessionKey)).toBe(true);
    expect(userBContext.workDir.startsWith(join(homedir(), ".brainrouter", "work", "user-b"))).toBe(true);
    expect(userBContext.workDir.endsWith(sessionKey)).toBe(true);
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

    expect(adminContext.workDir.startsWith(join(homedir(), ".brainrouter", "work", "admin"))).toBe(true);
    expect(adminContext.workDir.endsWith(sessionKey)).toBe(true);
    expect(adminContext.canvas).toContain("Authenticated user");
    expect(fallbackContext.workDir.startsWith(join(homedir(), ".brainrouter", "work", "default"))).toBe(true);
    expect(fallbackContext.workDir.endsWith(sessionKey)).toBe(true);
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

  it("round-trips kind:\"reasoning\" through offload → context", async () => {
    // 0.3.6 item 2c: agents now offload a structured "Why: …" step after
    // every non-trivial tool batch. The kind field is free-form on the
    // schema, so a regression that silently dropped or overwrote the value
    // (e.g. always-default to "tool_output") would erase the entire
    // audit-trail surface. Pin the round-trip explicitly.
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-reasoning-"));
    const userId = "user-1";
    const sessionKey = "reasoning-session";

    const offload = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload: "Decided to refactor canvas.ts because rendering by kind was missing.",
      title: "Why: refactor canvas for kind-aware rendering",
      summary: "Picked the dashed-border style for reasoning nodes.",
      kind: "reasoning",
    }));

    expect(offload.state.injectedState.currentNode.kind).toBe("reasoning");

    const context = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId,
      sessionKey,
    }));

    expect(context.steps).toHaveLength(1);
    expect(context.steps[0].kind).toBe("reasoning");
    expect(context.state.injectedState.recentSteps[0].kind).toBe("reasoning");
  });

  it("renders reasoning-kind nodes with a distinct Mermaid style in the canvas", async () => {
    // The canvas needs to visually separate reasoning ("why") nodes from
    // tool_output ("what came back") and compressed_summary ("the older
    // history got rolled up") nodes, so a human inspecting `canvas.mmd`
    // can see the decision trail at a glance. Pin the style emission so a
    // future refactor of canvas.ts can't silently flatten all kinds back
    // to a single shape.
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-working-canvas-kind-"));
    const userId = "user-1";
    const sessionKey = "canvas-kind-session";

    const tool = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload: "tool output payload",
      title: "Tool result",
      summary: "Read repo files",
      kind: "tool_output",
    }));
    const reason = parseToolJson(await handleMemoryWorkingTool("memory_working_offload", {
      workspacePath,
      userId,
      sessionKey,
      payload: "Chose dashed-border style because reasoning is conceptually different from tool output.",
      title: "Why: dashed style for reasoning",
      summary: "Visual separation of why vs. what.",
      kind: "reasoning",
    }));

    const context = parseToolJson(await handleMemoryWorkingTool("memory_working_context", {
      workspacePath,
      userId,
      sessionKey,
    }));

    // Reasoning node must carry a distinct stroke-dasharray style line.
    // Tool-output node must NOT carry that same dashed style — otherwise
    // the "distinct" claim is meaningless.
    expect(context.canvas).toMatch(new RegExp(`style ${reason.nodeId} [^\\n]*stroke-dasharray`));
    expect(context.canvas).not.toMatch(new RegExp(`style ${tool.nodeId} [^\\n]*stroke-dasharray`));
  });
});
