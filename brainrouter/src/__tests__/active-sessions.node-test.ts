/**
 * Federation Stage 2 (FED-S2-T1+T5) — `active_sessions` store contract.
 * Runs under `node --test` against the docker pgvector (see pgTestStore.ts).
 *
 * Covers:
 *   - Idempotent upsert via `registerActiveSession` — composite PK keeps
 *     `(sessionKey, userId)` collisions from stomping a peer.
 *   - `heartbeatActiveSession` returns false when no row exists,
 *     true after a register; usage snapshot carries through.
 *   - `listActiveSessions` default scope (last 2 min), `includeStale`,
 *     and `includeUsage` toggles.
 *   - `sweepActiveSessions` deletes rows past the threshold.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";
import { createTestStore } from "./helpers/pgTestStore.js";

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("registerActiveSession is idempotent on (sessionKey, userId) and preserves startedAt", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    const first = await store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: "2026-05-28T10:00:00.000Z",
      lastHeartbeatAt: "2026-05-28T10:00:00.000Z",
      metadata: {},
    });
    assert.equal(first.clientKind, "brainrouter-cli");

    // Re-register the same (sessionKey, userId) — clientKind updates,
    // startedAt is preserved.
    const second = await store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "codex", // client switched
      workspaceRoot: "/repos/alpha",
      startedAt: "2026-05-28T11:00:00.000Z", // ignored on conflict
      lastHeartbeatAt: "2026-05-28T11:00:00.000Z",
      metadata: { switched: true },
    });
    assert.equal(second.startedAt, "2026-05-28T10:00:00.000Z");
    assert.equal(second.clientKind, "codex");
    assert.equal(second.lastHeartbeatAt, "2026-05-28T11:00:00.000Z");
  } finally {
    await cleanup();
  }
});

test("composite key keeps two users' sessions separate even on key collision", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "shared-key",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/u1/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });
    await store.registerActiveSession({
      sessionKey: "shared-key", // same key, different user
      userId: "u2",
      clientKind: "claude-code",
      workspaceRoot: "/u2/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });
    const u1 = await store.listActiveSessions({ userId: "u1", includeStale: true });
    const u2 = await store.listActiveSessions({ userId: "u2", includeStale: true });
    assert.equal(u1.length, 1);
    assert.equal(u2.length, 1);
    assert.equal(u1[0].clientKind, "brainrouter-cli");
    assert.equal(u2[0].clientKind, "claude-code");
  } finally {
    await cleanup();
  }
});

test("heartbeatActiveSession returns false when row is missing, true after register, and updates usage", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    assert.equal(await store.heartbeatActiveSession("u1", "ghost", iso()), false);

    await store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-60_000),
      lastHeartbeatAt: iso(-60_000),
      metadata: {},
    });

    const later = iso();
    const ok = await store.heartbeatActiveSession("u1", "sk-1", later, {
      promptTokens: 1500,
      completionTokens: 240,
      totalUsd: 0.041,
      updatedAt: later,
    });
    assert.equal(ok, true);

    const [session] = await store.listActiveSessions({
      userId: "u1",
      includeStale: true,
      includeUsage: true,
    });
    assert.equal(session.lastHeartbeatAt, later);
    assert.equal(session.usage?.promptTokens, 1500);
    assert.equal(session.usage?.totalUsd, 0.041);
  } finally {
    await cleanup();
  }
});

test("listActiveSessions default filter excludes stale heartbeats; includeStale surfaces them", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "sk-fresh",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-30_000),
      lastHeartbeatAt: iso(-30_000), // 30 s ago → fresh
      metadata: {},
    });
    await store.registerActiveSession({
      sessionKey: "sk-stale",
      userId: "u1",
      clientKind: "codex",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-10 * 60_000),
      lastHeartbeatAt: iso(-10 * 60_000), // 10 min ago → stale
      metadata: {},
    });

    const fresh = await store.listActiveSessions({ userId: "u1" });
    assert.deepEqual(
      fresh.map((s: ActiveSessionRecord) => s.sessionKey),
      ["sk-fresh"],
    );

    const all = await store.listActiveSessions({ userId: "u1", includeStale: true });
    assert.equal(all.length, 2);
  } finally {
    await cleanup();
  }
});

test("listActiveSessions usage field is omitted unless includeUsage:true", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "sk-u",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
      usage: { promptTokens: 100, totalUsd: 0.01, updatedAt: iso() },
    });
    const [withoutUsage] = await store.listActiveSessions({ userId: "u1" });
    assert.equal(withoutUsage.usage, undefined);
    const [withUsage] = await store.listActiveSessions({ userId: "u1", includeUsage: true });
    assert.equal(withUsage.usage?.promptTokens, 100);
  } finally {
    await cleanup();
  }
});

test("sweepActiveSessions deletes rows past the threshold and returns the count", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "sk-fresh",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-30_000),
      lastHeartbeatAt: iso(-30_000),
      metadata: {},
    });
    await store.registerActiveSession({
      sessionKey: "sk-old",
      userId: "u1",
      clientKind: "codex",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-10 * 60_000),
      lastHeartbeatAt: iso(-10 * 60_000),
      metadata: {},
    });

    // Threshold = 5 min. sk-old (10 min stale) drops; sk-fresh (30 s) stays.
    const removed = await store.sweepActiveSessions(5 * 60_000);
    assert.equal(removed, 1);
    const remaining = await store.listActiveSessions({ userId: "u1", includeStale: true });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sessionKey, "sk-fresh");
  } finally {
    await cleanup();
  }
});

test("unregisterActiveSession deletes the matched row and is idempotent", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "sk-bye",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });

    assert.equal(await store.unregisterActiveSession("u1", "sk-bye"), true);
    assert.equal((await store.listActiveSessions({ userId: "u1", includeStale: true })).length, 0);

    // Second call must NOT throw.
    assert.equal(await store.unregisterActiveSession("u1", "sk-bye"), false);
  } finally {
    await cleanup();
  }
});

test("unregister scoped to (sessionKey, userId) — does not touch sibling user's row", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await store.registerActiveSession({
      sessionKey: "shared",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });
    await store.registerActiveSession({
      sessionKey: "shared",
      userId: "u2",
      clientKind: "claude-code",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });

    await store.unregisterActiveSession("u1", "shared");
    assert.equal((await store.listActiveSessions({ userId: "u1", includeStale: true })).length, 0);
    assert.equal((await store.listActiveSessions({ userId: "u2", includeStale: true })).length, 1);
  } finally {
    await cleanup();
  }
});

test("heartbeat does NOT write to memory_operations (audit volume guard)", async () => {
  const { store, url, cleanup } = await createTestStore();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });

    const countOps = async (): Promise<number> => {
      const res = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM memory_operations",
      );
      return Number(res.rows[0].n);
    };

    const beforeOps = await countOps();

    // Fire 10 heartbeats.
    for (let i = 0; i < 10; i++) {
      await store.heartbeatActiveSession("u1", "sk-1", iso());
    }

    const afterOps = await countOps();

    assert.equal(
      afterOps,
      beforeOps,
      "heartbeats must not add operation_log rows — would explode audit volume",
    );
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});
