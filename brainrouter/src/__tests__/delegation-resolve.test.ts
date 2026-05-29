import { describe, expect, it } from "vitest";
import { resolveDelegationPeer, buildDelegationPacket } from "../tools/delegation-helpers.js";

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
    expect(p.goal).toBe("do the thing");
    expect(p.fromSessionKey).toBe("sender-key");
    expect(p.files).toEqual(["a.ts", "b.ts"]); // non-strings dropped
    expect(p.constraints).toEqual([]); // non-array → []
    expect(p.modelHints).toEqual(["prefer:reasoning"]);
    expect(p.budget).toEqual({ tokens: 1000 });
    expect(p.deadline).toBe("2026-06-01");
    expect(p.createdAt).toBe("2026-05-29T00:00:00.000Z");
  });

  it("defaults missing optional fields safely", () => {
    const p = buildDelegationPacket("s", { goal: "x" }, "2026-05-29T00:00:00.000Z");
    expect(p.files).toEqual([]);
    expect(p.constraints).toEqual([]);
    expect(p.modelHints).toEqual([]);
    expect(p.budget).toBeNull();
    expect(p.deadline).toBeNull();
    expect(p.note).toBeUndefined();
    expect(p.originatingClient).toBe("unknown");
  });
});
