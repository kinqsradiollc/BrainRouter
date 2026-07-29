import { describe, expect, it } from "vitest";
import { buildDelegatedTaskPacket } from "@kinqs/brainrouter-core/orchestration/delegation-contracts";
import { resolveDelegationPeer, buildDelegationPacket } from "../tools/sessions/delegation-helpers.js";

const S = (sessionKey: string, clientKind: string, lastHeartbeatAt: string) => ({
  sessionKey,
  clientKind,
  lastHeartbeatAt,
});

describe("FED-S5 resolveDelegationPeer", () => {
  it("picks the idlest (oldest heartbeat) peer of the requested kind", () => {
    const sessions = [
      S("codex-a", "codex", "2026-05-29T00:00:30.000Z"),
      S("codex-b", "codex", "2026-05-29T00:00:10.000Z"), // idlest
      S("cc-1", "claude-code", "2026-05-29T00:00:01.000Z"),
    ];
    expect(resolveDelegationPeer(sessions, "codex", "sender")).toBe("codex-b");
  });

  it("is case-insensitive on kind and excludes the sender", () => {
    const sessions = [
      S("self", "codex", "2026-05-29T00:00:01.000Z"),
      S("codex-b", "codex", "2026-05-29T00:00:20.000Z"),
    ];
    expect(resolveDelegationPeer(sessions, "CODEX", "self")).toBe("codex-b");
  });

  it("returns null when no peer of that kind is active", () => {
    expect(resolveDelegationPeer([S("cc", "claude-code", "x")], "codex", "sender")).toBeNull();
  });
});

describe("FED-S5 buildDelegationPacket", () => {
  it("normalizes arrays + budget and stamps from/createdAt", () => {
    const p = buildDelegationPacket(
      "sender-key",
      {
        goal: "  do the thing  ",
        files: ["a.ts", 5, "b.ts"],
        constraints: "not-an-array",
        modelHints: ["prefer:reasoning"],
        budget: { tokens: 1000 },
        deadline: "2026-06-01",
        originatingClient: "brainrouter-cli",
        originatingWorkspace: "/ws",
      },
      "2026-05-29T00:00:00.000Z",
    );
    expect(p.task).toBe("do the thing");
    expect(p.origin.fromSessionKey).toBe("sender-key");
    expect(p.sources.files).toEqual(["a.ts", "b.ts"]); // non-strings dropped
    expect(p.userConstraints.constraints).toBeUndefined(); // non-array → []
    expect(p.toolPolicyCeiling).toEqual({
      accessMode: "read",
      localTools: [],
      mcpTools: [],
      disallowedTools: [],
    });
    expect(p.budgets.maxPromptTokens).toBe(1000);
    expect(p.userConstraints.deadline).toBe("2026-06-01");
    expect(p.origin.createdAt).toBe("2026-05-29T00:00:00.000Z");
  });

  it("defaults missing optional fields safely", () => {
    const p = buildDelegationPacket("s", { goal: "x" }, "2026-05-29T00:00:00.000Z");
    expect(p.sources.files).toEqual([]);
    expect(p.capabilities.active).toEqual([]);
    expect(p.toolPolicyCeiling.localTools).toEqual([]);
    expect(p.userConstraints.deadline).toBeUndefined();
    expect(p.origin.originatingClient).toBe("unknown");
  });

  it("pins transport identity and removes untrusted packet authority", () => {
    const taskPacket = buildDelegatedTaskPacket({
      task: "Inspect the authorization boundary.",
      personaId: "engineer",
      roleId: "reviewer",
      capabilities: {
        active: ["backend"],
        reasons: ["server task"],
        skillPacks: ["backend"],
        skills: ["authorization-boundary-skill"],
        toolProfiles: ["coding"],
        promptBlocks: [],
      },
      accessMode: "read",
      localTools: ["read_file", "grep_search"],
      mcpTools: ["mcp_docs_search"],
      disallowedTools: ["run_command"],
      budgets: {
        maxWallClockMs: 120_000,
        maxPromptTokens: 32_000,
        maxCompletionTokens: 4_000,
        maxIterations: 20,
        maxDepth: 1,
        maxOutputChars: 12_000,
      },
    });
    const packet = buildDelegationPacket(
      "authoritative-sender",
      {
        taskPacket,
        origin: { fromSessionKey: "spoofed" },
        originatingClient: "brainrouter-cli",
      },
      "2026-05-29T00:00:00.000Z",
    );

    expect(packet.task).toBe(taskPacket.task);
    expect(packet.persona).toEqual({ id: "custom" });
    expect(packet.orchestration).toEqual({ roleId: "worker" });
    expect(packet.capabilities.active).toEqual([]);
    expect(packet.toolPolicyCeiling).toEqual({
      accessMode: "read",
      localTools: [],
      mcpTools: [],
      disallowedTools: ["run_command"],
    });
    expect(packet.budgets.maxDepth).toBe(1);
    expect(packet.origin.fromSessionKey).toBe("authoritative-sender");
  });
});
