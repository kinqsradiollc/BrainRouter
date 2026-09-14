/**
 * ADR-015 P1c — memory_capture_turn scopes a turn by repo identity when the
 * client supplies a repoTag, and falls back to the workspace path hash otherwise.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { workspaceTagFromPath } from "@kinqs/brainrouter-types";

const { capture } = vi.hoisted(() => ({
  capture: vi.fn(async (_params: { workspaceTag: string | null }) => ({ cognitiveRecords: 0, sensoryCount: 0 })),
}));
vi.mock("../../memory/engine.js", () => ({
  memoryEngine: { capture, spikeSkill: () => {} },
}));

import { handleMemoryCaptureTurn } from "./memory_capture_turn.js";

const turn = {
  sessionKey: "s1",
  messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
  workspaceRoot: "/home/me/checkout-a",
};

afterEach(() => { capture.mockClear(); });

describe("memory_capture_turn repo scoping (ADR-015 P1c)", () => {
  it("scopes the captured turn by repoTag when one is supplied", async () => {
    const repoTag = "0123456789abcdef";
    await handleMemoryCaptureTurn({ ...turn, repoTag });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0][0].workspaceTag).toBe(repoTag);
  });

  it("falls back to the workspace path hash with no repoTag (unchanged behaviour)", async () => {
    await handleMemoryCaptureTurn(turn);
    expect(capture.mock.calls[0][0].workspaceTag).toBe(workspaceTagFromPath(turn.workspaceRoot));
  });

  it("a blank repoTag does not win over the path hash", async () => {
    await handleMemoryCaptureTurn({ ...turn, repoTag: "   " });
    expect(capture.mock.calls[0][0].workspaceTag).toBe(workspaceTagFromPath(turn.workspaceRoot));
  });
});
