/**
 * Federation Stage 3 (FED-S3-T1) — `session_inbox` store contract.
 *
 * Runs under `node --test` (see sqlite-wal.node-test.ts for the
 * vitest/node:sqlite limitation that pushed integration tests onto
 * the native node test runner).
 *
 * Covers:
 *   - Point-to-point send: one row addressed at the literal sessionKey.
 *   - `clientKind:*` broadcast: fans out to ONLY active peers of that
 *     kind under the same user. Cross-user isolation enforced.
 *   - `*` broadcast: fans out to every active peer under the user.
 *   - Inactive sessions are NOT recipients of broadcasts (they can't
 *     read their inbox while stale, so addressing into the past has
 *     no useful semantics).
 *   - `readSessionInbox` returns chronological order, scoped to the
 *     recipient + user, excludes delivered by default.
 *   - `ackSessionInbox` idempotent; stays scoped to recipient + user.
 *   - `sweepSessionInbox` deletes ONLY delivered rows older than the
 *     threshold — undelivered rows never silently drop.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestStore } from "./helpers/pgTestStore.js";
import type { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function registerSession(
  store: PostgresMemoryStore,
  userId: string,
  sessionKey: string,
  clientKind: string,
  heartbeatOffsetMs = 0,
): Promise<void> {
  const heartbeat = iso(heartbeatOffsetMs);
  await store.registerActiveSession({
    sessionKey,
    userId,
    clientKind,
    workspaceRoot: "/repos/alpha",
    startedAt: heartbeat,
    lastHeartbeatAt: heartbeat,
    metadata: {},
  });
}

test("sendSessionMessage: point-to-point writes exactly one row at the literal sessionKey", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-recip", "claude-code");
    const rows = await store.sendSessionMessage({
      userId: "u1",
      fromSessionKey: "sk-sender",
      toSessionKey: "sk-recip",
      kind: "text",
      payload: { text: "hi" },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].toSessionKey, "sk-recip");
    assert.equal(rows[0].fromSessionKey, "sk-sender");
    assert.deepEqual(rows[0].payload, { text: "hi" });
  } finally {
    await cleanup();
  }
});

test("sendSessionMessage: clientKind:* broadcasts only to active peers of that kind", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-bc-1", "brainrouter-cli");
    await registerSession(store, "u1", "sk-bc-2", "brainrouter-cli");
    await registerSession(store, "u1", "sk-cc-1", "claude-code");
    // Other-user peer — must not receive the broadcast.
    await registerSession(store, "u2", "sk-foreign", "brainrouter-cli");

    const rows = await store.sendSessionMessage({
      userId: "u1",
      fromSessionKey: "sk-sender",
      toSessionKey: "brainrouter-cli:*",
      kind: "text",
      payload: { text: "hi cli peers" },
    });
    const recipients = rows.map((r) => r.toSessionKey).sort();
    assert.deepEqual(recipients, ["sk-bc-1", "sk-bc-2"]);
  } finally {
    await cleanup();
  }
});

test("sendSessionMessage: * broadcasts to every active peer under the user", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-a", "brainrouter-cli");
    await registerSession(store, "u1", "sk-b", "claude-code");
    await registerSession(store, "u1", "sk-c", "codex");
    await registerSession(store, "u2", "sk-foreign", "brainrouter-cli");

    const rows = await store.sendSessionMessage({
      userId: "u1",
      fromSessionKey: "sk-sender",
      toSessionKey: "*",
      kind: "text",
      payload: { text: "everyone" },
    });
    const recipients = rows.map((r) => r.toSessionKey).sort();
    assert.deepEqual(recipients, ["sk-a", "sk-b", "sk-c"]);
  } finally {
    await cleanup();
  }
});

test("sendSessionMessage: broadcast skips stale (last-heartbeat > 2 min) peers", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-fresh", "brainrouter-cli", -30_000); // 30 s ago
    await registerSession(store, "u1", "sk-stale", "brainrouter-cli", -5 * 60_000); // 5 min ago

    const rows = await store.sendSessionMessage({
      userId: "u1",
      fromSessionKey: "sk-sender",
      toSessionKey: "*",
      kind: "text",
      payload: { text: "hi" },
    });
    assert.deepEqual(rows.map((r) => r.toSessionKey), ["sk-fresh"]);
  } finally {
    await cleanup();
  }
});

test("readSessionInbox: returns chronological order, scoped to recipient + user, excludes delivered by default", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-recip", "brainrouter-cli");
    // Insert three messages with explicit timestamps so order is deterministic.
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-recip",
        kind: "text",
        payload: { i: 1 },
      },
      { idGenerator: () => "m1", now: "2026-05-28T10:00:00.000Z" },
    );
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-recip",
        kind: "text",
        payload: { i: 2 },
      },
      { idGenerator: () => "m2", now: "2026-05-28T10:00:01.000Z" },
    );
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-recip",
        kind: "text",
        payload: { i: 3 },
      },
      { idGenerator: () => "m3", now: "2026-05-28T10:00:02.000Z" },
    );

    // Cross-user isolation: another user reading "sk-recip" sees nothing.
    const foreign = await store.readSessionInbox({ userId: "u2", toSessionKey: "sk-recip" });
    assert.equal(foreign.length, 0);

    const page = await store.readSessionInbox({ userId: "u1", toSessionKey: "sk-recip" });
    assert.deepEqual(
      page.map((m) => m.id),
      ["m1", "m2", "m3"],
    );

    // Ack the middle one; default read now skips it.
    await store.ackSessionInbox("u1", "sk-recip", ["m2"], iso());
    const undelivered = await store.readSessionInbox({ userId: "u1", toSessionKey: "sk-recip" });
    assert.deepEqual(
      undelivered.map((m) => m.id),
      ["m1", "m3"],
    );

    // includeDelivered: true surfaces the acked one again.
    const all = await store.readSessionInbox({
      userId: "u1",
      toSessionKey: "sk-recip",
      includeDelivered: true,
    });
    assert.deepEqual(
      all.map((m) => m.id),
      ["m1", "m2", "m3"],
    );
  } finally {
    await cleanup();
  }
});

test("ackSessionInbox: idempotent across repeated calls", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-r", "brainrouter-cli");
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-r",
        kind: "text",
        payload: {},
      },
      { idGenerator: () => "m1" },
    );

    assert.equal(await store.ackSessionInbox("u1", "sk-r", ["m1"], iso()), 1);
    // Second call: row is already delivered, returns 0 (idempotent).
    assert.equal(await store.ackSessionInbox("u1", "sk-r", ["m1"], iso()), 0);
    // Cross-user ack: returns 0, never touches the actual row.
    assert.equal(await store.ackSessionInbox("u2", "sk-r", ["m1"], iso()), 0);
  } finally {
    await cleanup();
  }
});

test("sweepSessionInbox: deletes ONLY delivered rows older than threshold", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-r", "brainrouter-cli");

    // Two old undelivered + two old delivered rows. Sweeper drops only
    // the delivered ones; undelivered must survive forever (no recipient
    // has read them yet).
    await store.sendSessionMessage(
      { userId: "u1", fromSessionKey: "f", toSessionKey: "sk-r", kind: "text", payload: {} },
      { idGenerator: () => "old-undelivered-1", now: "2020-01-01T00:00:00Z" },
    );
    await store.sendSessionMessage(
      { userId: "u1", fromSessionKey: "f", toSessionKey: "sk-r", kind: "text", payload: {} },
      { idGenerator: () => "old-undelivered-2", now: "2020-01-01T00:00:00Z" },
    );
    await store.sendSessionMessage(
      { userId: "u1", fromSessionKey: "f", toSessionKey: "sk-r", kind: "text", payload: {} },
      { idGenerator: () => "old-delivered-1", now: "2020-01-01T00:00:00Z" },
    );
    await store.sendSessionMessage(
      { userId: "u1", fromSessionKey: "f", toSessionKey: "sk-r", kind: "text", payload: {} },
      { idGenerator: () => "old-delivered-2", now: "2020-01-01T00:00:00Z" },
    );
    await store.ackSessionInbox("u1", "sk-r", ["old-delivered-1", "old-delivered-2"], "2020-01-01T00:00:01Z");

    // Sweep "anything delivered older than 1 hour". Both delivered rows
    // qualify; both undelivered rows must remain.
    const removed = await store.sweepSessionInbox(60 * 60_000);
    assert.equal(removed, 2);

    const remaining = await store.readSessionInbox({
      userId: "u1",
      toSessionKey: "sk-r",
      includeDelivered: true,
    });
    assert.deepEqual(
      remaining.map((m) => m.id).sort(),
      ["old-undelivered-1", "old-undelivered-2"],
    );
  } finally {
    await cleanup();
  }
});
