import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    capturePassiveL0: vi.fn((params: { sessionKey: string }) => ({
      id: `l0-${params.sessionKey}`,
      userId: "user-1",
      sessionKey: params.sessionKey,
      sessionId: "",
      role: "tool",
      messageText: "{}",
      recordedAt: new Date().toISOString(),
      timestamp: Date.now(),
      skillTag: "host:claude-code",
    })),
    getUserByApiKey: vi.fn((apiKey: string) => {
      if (apiKey === "br_admin") {
        return {
          userId: "admin",
          isAdmin: true,
          email: "admin@example.test",
          status: "active",
        };
      }
      if (apiKey === "br_user") {
        return {
          userId: "user-1",
          isAdmin: false,
          email: "user@example.test",
          status: "active",
        };
      }
      return null;
    }),
    getUserById: vi.fn(() => ({
      userId: "user-1",
      isAdmin: false,
      email: "user@example.test",
      status: "active",
    })),
  },
}));

async function createServer() {
  const [{ workingRouter }, { hooksRouter }] = await Promise.all([
    import("../api/routes/working.js"),
    import("../api/routes/hooks.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/working", workingRouter);
  app.use("/api/hooks", hooksRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("Phase 4 and 5 API routes", () => {
  let server: Awaited<ReturnType<typeof createServer>>["server"];
  let baseUrl = "";

  beforeEach(async () => {
    const created = await createServer();
    server = created.server;
    baseUrl = created.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("serves working context, offload, and reset endpoints", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-api-working-"));
    const auth = { Authorization: "Bearer br_user" };

    const offload = await fetch(`${baseUrl}/api/working/offload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        workspacePath,
        sessionKey: "api-working-session",
        payload: "tool output",
        title: "Tool output",
      }),
    });
    expect(offload.status).toBe(201);
    const offloadJson = await offload.json() as { nodeId: string; pressureLevel: string };
    expect(offloadJson.nodeId).toMatch(/^w/);

    const context = await fetch(`${baseUrl}/api/working/context?sessionKey=api-working-session&workspacePath=${encodeURIComponent(workspacePath)}`, {
      headers: auth,
    });
    expect(context.status).toBe(200);
    const contextJson = await context.json() as { canvas: string; steps: unknown[] };
    expect(contextJson.canvas).toContain("flowchart TD");
    expect(contextJson.steps).toHaveLength(1);

    const reset = await fetch(`${baseUrl}/api/working/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ workspacePath, sessionKey: "api-working-session" }),
    });
    expect(reset.status).toBe(200);
    const resetJson = await reset.json() as { deleted: boolean };
    expect(resetJson.deleted).toBe(true);
  });

  it("registers hooks and reports status", async () => {
    const auth = { Authorization: "Bearer br_user" };
    const register = await fetch(`${baseUrl}/api/hooks/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        source: "claude-code",
        events: ["PostToolUse"],
        sessionKey: "api-hook-session",
        event: "PostToolUse",
        payload: { tool_name: "Bash", tool_input: { command: "echo ok" } },
      }),
    });
    expect(register.status).toBe(201);
    const registerJson = await register.json() as { captureResult: { l0RecordedCount: number } };
    expect(registerJson.captureResult.l0RecordedCount).toBe(1);

    const status = await fetch(`${baseUrl}/api/hooks/status?source=claude-code`, { headers: auth });
    expect(status.status).toBe(200);
    const statusJson = await status.json() as { hooks: Array<{ id: string; userId: string; lastEvent: string | null }> };
    expect(statusJson.hooks.some((hook) => hook.id === "user-1:claude-code:api-hook-session" && hook.userId === "user-1")).toBe(true);
  });

  it("rejects non-admin hook registration for another user", async () => {
    const response = await fetch(`${baseUrl}/api/hooks/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer br_user" },
      body: JSON.stringify({
        source: "codex",
        userId: "other-user",
        sessionKey: "blocked-session",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects non-admin working memory access for another user", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "brainrouter-api-working-rbac-"));
    const response = await fetch(`${baseUrl}/api/working/context?sessionKey=blocked-session&userId=other-user&workspacePath=${encodeURIComponent(workspacePath)}`, {
      headers: { Authorization: "Bearer br_user" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects non-admin hook status reads for another user", async () => {
    const response = await fetch(`${baseUrl}/api/hooks/status?userId=other-user`, {
      headers: { Authorization: "Bearer br_user" },
    });
    expect(response.status).toBe(403);
  });
});
