import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      registerActiveSession: vi.fn(),
      heartbeatActiveSession: vi.fn(),
      listActiveSessions: vi.fn(),
      sweepActiveSessions: vi.fn(),
    },
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleSessionRegister,
  handleSessionHeartbeat,
  handleSessionList,
} from "../tools/active_sessions.js";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";

function parseToolText<T>(result: any): T {
  return JSON.parse(result.content[0].text);
}

function record(overrides: Partial<ActiveSessionRecord> = {}): ActiveSessionRecord {
  return {
    sessionKey: "sk-1",
    userId: "u1",
    clientKind: "brainrouter-cli",
    workspaceRoot: "/repos/alpha",
    startedAt: "2026-05-28T10:00:00.000Z",
    lastHeartbeatAt: "2026-05-28T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("session_register tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockReset();
  });

  it("mints a fresh sessionKey when none is provided", async () => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation((r) => r);
    const res = parseToolText<{ session: ActiveSessionRecord }>(
      await handleSessionRegister(
        { clientKind: "brainrouter-cli", workspaceRoot: "/repos/alpha" },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.session.sessionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.session.clientKind).toBe("brainrouter-cli");
    expect(res.session.userId).toBe("u1");
  });

  it("preserves a client-supplied sessionKey (idempotent re-register)", async () => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation((r) => r);
    const res = parseToolText<{ session: ActiveSessionRecord }>(
      await handleSessionRegister(
        { sessionKey: "stable-sk", clientKind: "codex" },
        { defaultUserId: "u1" },
      ),
    );
    expect(res.session.sessionKey).toBe("stable-sk");
    expect(memoryEngine.store.registerActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "stable-sk", clientKind: "codex" }),
    );
  });

  it("falls back to http-unknown when client doesn't self-identify", async () => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation((r) => r);
    const res = parseToolText<{ session: ActiveSessionRecord }>(
      await handleSessionRegister({}, { defaultUserId: "u1" }),
    );
    expect(res.session.clientKind).toBe("http-unknown");
  });

  it("returns isError envelope when the store throws", async () => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation(() => {
      throw new Error("disk full");
    });
    const result: any = await handleSessionRegister({}, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_register failed: disk full/);
  });
});

describe("session_heartbeat tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockReset();
  });

  it("returns updated:true and the new timestamp on success", async () => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockReturnValue(true);
    const res = parseToolText<{ updated: boolean; at: string }>(
      await handleSessionHeartbeat({ sessionKey: "sk-1" }, { defaultUserId: "u1" }),
    );
    expect(res.updated).toBe(true);
    expect(res.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns updated:false when no row exists (client should re-register)", async () => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockReturnValue(false);
    const res = parseToolText<{ updated: boolean }>(
      await handleSessionHeartbeat({ sessionKey: "ghost" }, { defaultUserId: "u1" }),
    );
    expect(res.updated).toBe(false);
  });

  it("passes usage snapshot when provided", async () => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockReturnValue(true);
    await handleSessionHeartbeat(
      {
        sessionKey: "sk-1",
        usage: { promptTokens: 1500, totalUsd: 0.04, cachedPromptTokens: 800 },
      },
      { defaultUserId: "u1" },
    );
    expect(memoryEngine.store.heartbeatActiveSession).toHaveBeenCalledWith(
      "u1",
      "sk-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.objectContaining({ promptTokens: 1500, totalUsd: 0.04 }),
    );
  });

  it("rejects when sessionKey is missing", async () => {
    const result: any = await handleSessionHeartbeat({}, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_heartbeat failed/);
  });
});

describe("session_list tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockReset();
  });

  it("returns the store's session list", async () => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockReturnValue([
      record({ sessionKey: "sk-1", clientKind: "brainrouter-cli" }),
      record({ sessionKey: "sk-2", clientKind: "claude-code" }),
    ]);
    const res = parseToolText<{ sessions: ActiveSessionRecord[] }>(
      await handleSessionList({}, { defaultUserId: "u1" }),
    );
    expect(res.sessions).toHaveLength(2);
    expect(res.sessions.map((s) => s.clientKind).sort()).toEqual(["brainrouter-cli", "claude-code"]);
  });

  it("forwards includeStale + includeUsage filters to the store", async () => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockReturnValue([]);
    await handleSessionList(
      { clientKind: "codex", includeStale: true, includeUsage: true, staleThresholdMs: 60_000 },
      { defaultUserId: "u1" },
    );
    expect(memoryEngine.store.listActiveSessions).toHaveBeenCalledWith({
      userId: "u1",
      clientKind: "codex",
      workspaceRoot: undefined,
      includeStale: true,
      staleThresholdMs: 60_000,
      includeUsage: true,
    });
  });

  it("returns isError envelope when the store throws", async () => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockImplementation(() => {
      throw new Error("bad query");
    });
    const result: any = await handleSessionList({}, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_list failed: bad query/);
  });
});
