/**
 * Active-session tool contract regressions.
 *
 * Tests pin tenant/claim forwarding, exact-key validation, idempotent lifecycle,
 * and truthful registration/heartbeat results before any store mutation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    store: {
      registerActiveSession: vi.fn(),
      heartbeatActiveSession: vi.fn(),
      unregisterActiveSession: vi.fn(),
      listActiveSessions: vi.fn(),
      sweepActiveSessions: vi.fn(),
    },
  },
}));

import { memoryEngine } from "../memory/engine.js";
import {
  handleSessionRegister,
  handleSessionHeartbeat,
  handleSessionUnregister,
  handleSessionList,
} from "../tools/sessions/active_sessions.js";
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

describe("exact session key validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects whitespace, control characters, and oversized keys before storage", async () => {
    const results = await Promise.all([
      handleSessionRegister({ sessionKey: " leading-space" }, { defaultUserId: "u1" }),
      handleSessionHeartbeat({ sessionKey: "line\nbreak" }, { defaultUserId: "u1" }),
      handleSessionUnregister({ sessionKey: "peer\u001b]52;c;clipboard\u0007" }, { defaultUserId: "u1" }),
      handleSessionRegister({ sessionKey: "x".repeat(513) }, { defaultUserId: "u1" }),
    ]);
    expect(results.every((result: any) => result.isError === true)).toBe(true);
    expect(memoryEngine.store.registerActiveSession).not.toHaveBeenCalled();
    expect(memoryEngine.store.heartbeatActiveSession).not.toHaveBeenCalled();
    expect(memoryEngine.store.unregisterActiveSession).not.toHaveBeenCalled();
  });
});

describe("session_register tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockReset();
  });

  it("mints a fresh sessionKey when none is provided", async () => {
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation(async (r) => r);
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
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation(async (r) => r);
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
    vi.mocked(memoryEngine.store.registerActiveSession).mockImplementation(async (r) => r);
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
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockResolvedValue(true);
    const res = parseToolText<{ updated: boolean; at: string }>(
      await handleSessionHeartbeat({ sessionKey: "sk-1" }, { defaultUserId: "u1" }),
    );
    expect(res.updated).toBe(true);
    expect(res.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns updated:false when no row exists (client should re-register)", async () => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockResolvedValue(false);
    const res = parseToolText<{ updated: boolean }>(
      await handleSessionHeartbeat({ sessionKey: "ghost" }, { defaultUserId: "u1" }),
    );
    expect(res.updated).toBe(false);
  });

  it("passes usage snapshot when provided", async () => {
    vi.mocked(memoryEngine.store.heartbeatActiveSession).mockResolvedValue(true);
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
      null,
    );
  });

  it("rejects when sessionKey is missing", async () => {
    const result: any = await handleSessionHeartbeat({}, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_heartbeat failed/);
  });
});

describe("session_unregister tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.unregisterActiveSession).mockReset();
  });

  it("returns deleted:true when the row existed", async () => {
    vi.mocked(memoryEngine.store.unregisterActiveSession).mockResolvedValue(true);
    const res = parseToolText<{ deleted: boolean }>(
      await handleSessionUnregister({ sessionKey: "sk-1" }, { defaultUserId: "u1" }),
    );
    expect(res.deleted).toBe(true);
    expect(memoryEngine.store.unregisterActiveSession).toHaveBeenCalledWith("u1", "sk-1", null);
  });

  it("is idempotent — returns deleted:false when no row exists", async () => {
    vi.mocked(memoryEngine.store.unregisterActiveSession).mockResolvedValue(false);
    const res = parseToolText<{ deleted: boolean }>(
      await handleSessionUnregister({ sessionKey: "ghost" }, { defaultUserId: "u1" }),
    );
    expect(res.deleted).toBe(false);
  });

  it("rejects when sessionKey is missing", async () => {
    const result: any = await handleSessionUnregister({}, { defaultUserId: "u1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_unregister failed/);
  });

  it("returns isError envelope when the store throws", async () => {
    vi.mocked(memoryEngine.store.unregisterActiveSession).mockImplementation(() => {
      throw new Error("db locked");
    });
    const result: any = await handleSessionUnregister(
      { sessionKey: "sk-1" },
      { defaultUserId: "u1" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/session_unregister failed: db locked/);
  });
});

describe("session_list tool", () => {
  beforeEach(() => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockReset();
  });

  it("returns the store's session list", async () => {
    vi.mocked(memoryEngine.store.listActiveSessions).mockResolvedValue([
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
    vi.mocked(memoryEngine.store.listActiveSessions).mockResolvedValue([]);
    await handleSessionList(
      { clientKind: "codex", includeStale: true, includeUsage: true, staleThresholdMs: 60_000 },
      { defaultUserId: "u1" },
    );
    expect(memoryEngine.store.listActiveSessions).toHaveBeenCalledWith({
      userId: "u1",
      orgId: null,
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
