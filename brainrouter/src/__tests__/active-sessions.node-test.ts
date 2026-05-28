/**
 * Federation Stage 2 (FED-S2-T1+T5) — `active_sessions` store contract.
 * Runs under `node --test` (see sqlite-wal.node-test.ts for the
 * vitest/node:sqlite limitation explanation).
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../memory/store/sqlite.js";

function freshDb(label: string): { store: SqliteMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `brainrouter-active-${label}-`));
  const store = new SqliteMemoryStore(join(dir, "memory.db"));
  store.init();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("registerActiveSession is idempotent on (sessionKey, userId) and preserves startedAt", () => {
  const { store, cleanup } = freshDb("upsert");
  try {
    const first = store.registerActiveSession({
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
    const second = store.registerActiveSession({
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
    cleanup();
  }
});

test("composite key keeps two users' sessions separate even on key collision", () => {
  const { store, cleanup } = freshDb("composite");
  try {
    store.registerActiveSession({
      sessionKey: "shared-key",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/u1/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });
    store.registerActiveSession({
      sessionKey: "shared-key", // same key, different user
      userId: "u2",
      clientKind: "claude-code",
      workspaceRoot: "/u2/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });
    const u1 = store.listActiveSessions({ userId: "u1", includeStale: true });
    const u2 = store.listActiveSessions({ userId: "u2", includeStale: true });
    assert.equal(u1.length, 1);
    assert.equal(u2.length, 1);
    assert.equal(u1[0].clientKind, "brainrouter-cli");
    assert.equal(u2[0].clientKind, "claude-code");
  } finally {
    cleanup();
  }
});

test("heartbeatActiveSession returns false when row is missing, true after register, and updates usage", () => {
  const { store, cleanup } = freshDb("hb");
  try {
    assert.equal(store.heartbeatActiveSession("u1", "ghost", iso()), false);

    store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-60_000),
      lastHeartbeatAt: iso(-60_000),
      metadata: {},
    });

    const later = iso();
    const ok = store.heartbeatActiveSession("u1", "sk-1", later, {
      promptTokens: 1500,
      completionTokens: 240,
      totalUsd: 0.041,
      updatedAt: later,
    });
    assert.equal(ok, true);

    const [session] = store.listActiveSessions({
      userId: "u1",
      includeStale: true,
      includeUsage: true,
    });
    assert.equal(session.lastHeartbeatAt, later);
    assert.equal(session.usage?.promptTokens, 1500);
    assert.equal(session.usage?.totalUsd, 0.041);
  } finally {
    cleanup();
  }
});

test("listActiveSessions default filter excludes stale heartbeats; includeStale surfaces them", () => {
  const { store, cleanup } = freshDb("stale");
  try {
    store.registerActiveSession({
      sessionKey: "sk-fresh",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-30_000),
      lastHeartbeatAt: iso(-30_000), // 30 s ago → fresh
      metadata: {},
    });
    store.registerActiveSession({
      sessionKey: "sk-stale",
      userId: "u1",
      clientKind: "codex",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-10 * 60_000),
      lastHeartbeatAt: iso(-10 * 60_000), // 10 min ago → stale
      metadata: {},
    });

    const fresh = store.listActiveSessions({ userId: "u1" });
    assert.deepEqual(
      fresh.map((s) => s.sessionKey),
      ["sk-fresh"],
    );

    const all = store.listActiveSessions({ userId: "u1", includeStale: true });
    assert.equal(all.length, 2);
  } finally {
    cleanup();
  }
});

test("listActiveSessions usage field is omitted unless includeUsage:true", () => {
  const { store, cleanup } = freshDb("usage");
  try {
    store.registerActiveSession({
      sessionKey: "sk-u",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
      usage: { promptTokens: 100, totalUsd: 0.01, updatedAt: iso() },
    });
    const [withoutUsage] = store.listActiveSessions({ userId: "u1" });
    assert.equal(withoutUsage.usage, undefined);
    const [withUsage] = store.listActiveSessions({ userId: "u1", includeUsage: true });
    assert.equal(withUsage.usage?.promptTokens, 100);
  } finally {
    cleanup();
  }
});

test("sweepActiveSessions deletes rows past the threshold and returns the count", () => {
  const { store, cleanup } = freshDb("sweep");
  try {
    store.registerActiveSession({
      sessionKey: "sk-fresh",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-30_000),
      lastHeartbeatAt: iso(-30_000),
      metadata: {},
    });
    store.registerActiveSession({
      sessionKey: "sk-old",
      userId: "u1",
      clientKind: "codex",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(-10 * 60_000),
      lastHeartbeatAt: iso(-10 * 60_000),
      metadata: {},
    });

    // Threshold = 5 min. sk-old (10 min stale) drops; sk-fresh (30 s) stays.
    const removed = store.sweepActiveSessions(5 * 60_000);
    assert.equal(removed, 1);
    const remaining = store.listActiveSessions({ userId: "u1", includeStale: true });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sessionKey, "sk-fresh");
  } finally {
    cleanup();
  }
});

test("heartbeat does NOT write to memory_operations (audit volume guard)", () => {
  const { store, cleanup } = freshDb("audit");
  try {
    store.registerActiveSession({
      sessionKey: "sk-1",
      userId: "u1",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/alpha",
      startedAt: iso(),
      lastHeartbeatAt: iso(),
      metadata: {},
    });

    const beforeOps = (store as unknown as {
      db: { prepare(sql: string): { get(...args: unknown[]): unknown } };
    }).db
      .prepare("SELECT COUNT(*) as n FROM memory_operations")
      .get() as { n: number };

    // Fire 10 heartbeats.
    for (let i = 0; i < 10; i++) {
      store.heartbeatActiveSession("u1", "sk-1", iso());
    }

    const afterOps = (store as unknown as {
      db: { prepare(sql: string): { get(...args: unknown[]): unknown } };
    }).db
      .prepare("SELECT COUNT(*) as n FROM memory_operations")
      .get() as { n: number };

    assert.equal(
      afterOps.n,
      beforeOps.n,
      "heartbeats must not add operation_log rows — would explode audit volume",
    );
  } finally {
    cleanup();
  }
});
