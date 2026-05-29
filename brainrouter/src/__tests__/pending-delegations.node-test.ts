import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";
import type { DelegationPacket } from "@kinqs/brainrouter-types";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-pending-deleg-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function packet(goal: string): DelegationPacket {
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

test("FED-S5: enqueue → list → claim oldest-first; flips status; preserves packet", () => {
  const { store, cleanup } = freshDb("flow");
  try {
    const a = store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("first") },
      { now: "2026-05-29T00:00:01.000Z" },
    );
    store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("second") },
      { now: "2026-05-29T00:00:02.000Z" },
    );
    // different kind — must not be picked by a codex claimer
    store.enqueuePendingDelegation(
      { userId: "u1", fromSessionKey: "s", toAgentKind: "claude-code", packet: packet("other") },
      { now: "2026-05-29T00:00:03.000Z" },
    );

    const pending = store.listPendingDelegations({ userId: "u1", toAgentKind: "codex", status: "pending" });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].id, a.id); // oldest first
    assert.equal(pending[0].packet.goal, "first");

    const claimed = store.claimPendingDelegation("u1", "codex", "claimer-1", "2026-05-29T00:01:00.000Z");
    assert.equal(claimed?.packet.goal, "first");
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.toSessionKey, "claimer-1");

    const claimed2 = store.claimPendingDelegation("u1", "codex", "claimer-2", "2026-05-29T00:02:00.000Z");
    assert.equal(claimed2?.packet.goal, "second");

    const none = store.claimPendingDelegation("u1", "codex", "claimer-3", "2026-05-29T00:03:00.000Z");
    assert.equal(none, null); // queue drained

    // the claude-code one is untouched
    const cc = store.listPendingDelegations({ userId: "u1", toAgentKind: "claude-code", status: "pending" });
    assert.equal(cc.length, 1);
  } finally {
    cleanup();
  }
});

test("FED-S5: claim is user-scoped (no cross-tenant leakage)", () => {
  const { store, cleanup } = freshDb("tenant");
  try {
    store.enqueuePendingDelegation({ userId: "u1", fromSessionKey: "s", toAgentKind: "codex", packet: packet("u1-task") });
    const otherUser = store.claimPendingDelegation("u2", "codex", "claimer", "2026-05-29T00:01:00.000Z");
    assert.equal(otherUser, null);
    const sameUser = store.claimPendingDelegation("u1", "codex", "claimer", "2026-05-29T00:01:00.000Z");
    assert.equal(sameUser?.packet.goal, "u1-task");
  } finally {
    cleanup();
  }
});
