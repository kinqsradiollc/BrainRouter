import { describe, expect, it } from "vitest";

import { processClaudeCodeHook } from "../integrations/claude-code.js";
import { listHostHooks, registerHostHook } from "../integrations/generic-mcp.js";

describe("host integrations", () => {
  it("captures a Claude Code PostToolUse event as redacted L0 memory", async () => {
    const records: Array<{ id: string; messageText: string; skillTag: string }> = [];
    const engine = {
      capturePassiveL0(params: { content: string; skillTag?: string }) {
        const record = {
          id: "l0-test",
          userId: "user-1",
          sessionKey: "claude-session",
          sessionId: "",
          role: "tool",
          messageText: params.content,
          recordedAt: new Date().toISOString(),
          timestamp: Date.now(),
          skillTag: params.skillTag ?? "",
        };
        records.push(record);
        return record;
      },
    };

    const result = await processClaudeCodeHook(engine, {
      event: "PostToolUse",
      userId: "user-1",
      sessionKey: "claude-session",
      tool_name: "Bash",
      tool_input: {
        command: "curl -H 'Authorization: Bearer sk-test-key-value' https://example.test",
        apiKey: "sk-test-key-value",
      },
    }, "default");

    expect(result.l0RecordedCount).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.skillTag).toBe("host:claude-code");
    expect(records[0]!.messageText).toContain("PostToolUse");
    expect(records[0]!.messageText).toContain("Bash");
    expect(records[0]!.messageText).not.toContain("sk-test-key-value");
    expect(records[0]!.messageText).toContain("[REDACTED]");
  });

  it("registers hooks and reports last-seen status", async () => {
    registerHostHook({
      userId: "user-1",
      source: "claude-code",
      events: ["PreToolUse", "PostToolUse", "Stop", "SubagentStop"],
      sessionKey: "status-session",
    });

    const status = { hooks: listHostHooks("user-1").filter((hook) => hook.source === "claude-code") };

    expect(status.hooks.some((hook: any) => hook.id === "user-1:claude-code:status-session")).toBe(true);
  });

  it("resolves workspacePath from registration database if omitted in a Stop event", async () => {
    registerHostHook({
      userId: "user-1",
      source: "claude-code",
      events: ["Stop"],
      sessionKey: "session-without-path",
      workspacePath: "/resolved/path/from/db",
    });

    const engine = {
      capturePassiveL0(params: { userId: string; sessionKey: string; sessionId?: string; role: string; content: string; timestamp?: number; skillTag?: string }) {
        return {
          id: "l0-test",
          userId: params.userId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId ?? "",
          role: params.role,
          messageText: params.content,
          recordedAt: new Date().toISOString(),
          timestamp: params.timestamp ?? Date.now(),
          skillTag: params.skillTag ?? "",
        };
      },
    };

    const result = await processClaudeCodeHook(engine, {
      event: "Stop",
      userId: "user-1",
      sessionKey: "session-without-path",
    }, "default");

    expect(result.flushedWorkingMemory).toBe(true);
  });
});
