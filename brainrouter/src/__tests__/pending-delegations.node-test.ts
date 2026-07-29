import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import type {
  LegacyDelegationPacket,
  StoredDelegationPacket,
} from "@kinqs/brainrouter-types/agent";

function packet(goal: string): LegacyDelegationPacket {
  return {
    goal,
    fromSessionKey: "sender",
    originatingClient: "brainrouter-cli",
    originatingWorkspace: "/ws",
    files: ["a.ts"],
    constraints: ["no breaking changes"],
    modelHints: [],
    budget: null,
    deadline: null,
    createdAt: "2026-05-29T00:00:00.000Z",
  };
}

function packetGoal(packet: StoredDelegationPacket): string {
  return "goal" in packet ? packet.goal : packet.task;
}

test("FED-S5: enqueue → list → claim oldest-first; flips status; preserves packet", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const a = await store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("first") },
      { now: "2026-05-29T00:00:01.000Z" },
    );
    await store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("second") },
      { now: "2026-05-29T00:00:02.000Z" },
    );
    // different kind — must not be picked by a codex claimer
    await store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "claude-code", packet: packet("other") },
      { now: "2026-05-29T00:00:03.000Z" },
    );

    const pending = await store.listPendingDelegations({ userId: "u1", toAgentKind: "codex", status: "pending" });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].id, a.id); // oldest first
    assert.equal(packetGoal(pending[0].packet), "first");

    const claimed = await store.claimPendingDelegation("u1", "codex", "claimer-1", "2026-05-29T00:01:00.000Z");
    assert.equal(claimed && packetGoal(claimed.packet), "first");
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.toSessionKey, "claimer-1");

    const claimed2 = await store.claimPendingDelegation("u1", "codex", "claimer-2", "2026-05-29T00:02:00.000Z");
    assert.equal(claimed2 && packetGoal(claimed2.packet), "second");

    const none = await store.claimPendingDelegation("u1", "codex", "claimer-3", "2026-05-29T00:03:00.000Z");
    assert.equal(none, null); // queue drained

    // the claude-code one is untouched
    const cc = await store.listPendingDelegations({ userId: "u1", toAgentKind: "claude-code", status: "pending" });
    assert.equal(cc.length, 1);
  } finally {
    await cleanup();
  }
});

test("FED-S5: claim is user-scoped (no cross-tenant leakage)", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.enqueuePendingDelegation({ userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("u1-task") });
    const otherUser = await store.claimPendingDelegation("u2", "codex", "claimer", "2026-05-29T00:01:00.000Z");
    assert.equal(otherUser, null);
    const sameUser = await store.claimPendingDelegation("u1", "codex", "claimer", "2026-05-29T00:01:00.000Z");
    assert.equal(sameUser && packetGoal(sameUser.packet), "u1-task");
  } finally {
    await cleanup();
  }
});
