/**
 * Federation Stage 3 (FED-S3-T1) — `session_inbox` store contract.
 *
 * Runs under `node --test` against a scratch Postgres database.
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
 *   - Pending rows expire durably and terminal receipts are retained.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { SESSION_MESSAGE_NOTIFICATION_CHANNEL } from "@kinqs/brainrouter-types";
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
  orgId?: string | null,
): Promise<void> {
  const heartbeat = iso(heartbeatOffsetMs);
  await store.registerActiveSession({
    sessionKey,
    orgId,
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
    await registerSession(store, "u1", "sk-sender", "terminal-client");
    await registerSession(store, "u1", "sk-recip", "editor-client");
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
    assert.deepEqual(rows[0].payload, {
      text: "hi",
      senderClientKind: "terminal-client",
      senderWorkspaceRoot: "/repos/alpha",
    });
  } finally {
    await cleanup();
  }
});

test("routeSessionMessage: enforces tenant authority, active endpoints, idempotency, receipts, and commit wakes", async () => {
  const { store, url, cleanup } = await createTestStore();
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  try {
    await listener.query(`LISTEN ${SESSION_MESSAGE_NOTIFICATION_CHANNEL}`);
    await registerSession(store, "u1", "sender", "terminal-client", 0, "org-a");
    await registerSession(store, "u1", "recipient", "editor-client", 0, "org-b");

    const inactive = await store.routeSessionMessage({
      orgId: "org-a",
      userId: "u1",
      messageId: "inactive-sender",
      fromSessionKey: "missing",
      toSessionKey: "recipient",
      kind: "text",
      payload: { text: "blocked" },
    });
    assert.equal(inactive.rejectionReason, "sender_not_active");
    assert.equal(inactive.receipts.length, 0);

    const crossTenant = await store.routeSessionMessage({
      orgId: "org-a",
      userId: "u1",
      messageId: "cross-tenant",
      fromSessionKey: "sender",
      toSessionKey: "recipient",
      kind: "text",
      payload: { text: "blocked" },
    });
    assert.equal(crossTenant.rejectionReason, "recipient_not_active");
    assert.equal(crossTenant.receipts[0]?.status, "rejected");

    await registerSession(store, "u1", "recipient", "editor-client", 0, "org-a");
    const notification = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("session notification timed out")), 2_000);
      listener.on("notification", (message) => {
        const parsed = JSON.parse(message.payload ?? "{}") as Record<string, unknown>;
        if (parsed.messageId === "message-1") {
          clearTimeout(timeout);
          resolve(parsed);
        }
      });
    });
    const input = {
      orgId: "org-a",
      userId: "u1",
      messageId: "message-1",
      fromSessionKey: "sender",
      toSessionKey: "recipient",
      kind: "text" as const,
      payload: { text: "hello", nested: { b: 2, a: 1 } },
    };
    const first = await store.routeSessionMessage(input, { receiptIdGenerator: () => "receipt-1" });
    assert.equal(first.accepted, 1);
    assert.equal(first.deliveries[0]?.id, "receipt-1");
    assert.equal(first.deliveries[0]?.expiresAt, new Date(Date.parse(first.deliveries[0]!.createdAt) + 24 * 60 * 60 * 1000).toISOString());

    const wake = await notification;
    assert.equal(wake.orgId, "org-a");
    assert.equal(wake.toSessionKey, "recipient");
    assert.equal(wake.inboxId, "receipt-1");
    assert.equal(wake.status, "pending");

    const replay = await store.routeSessionMessage({
      ...input,
      payload: { nested: { a: 1, b: 2 }, text: "hello" },
    });
    assert.equal(replay.idempotentReplay, true);
    assert.deepEqual(replay.receipts.map((row) => row.id), ["receipt-1"]);
    await assert.rejects(
      () => store.routeSessionMessage({ ...input, payload: { text: "changed" } }),
      (error: Error & { code?: string }) => error.code === "SESSION_MESSAGE_IDEMPOTENCY_CONFLICT",
    );

    const senderReceipts = await store.readSessionMessageReceipts({
      orgId: "org-a", userId: "u1", fromSessionKey: "sender", messageId: "message-1",
    });
    assert.deepEqual(senderReceipts.map((row) => row.id), ["receipt-1"]);
    assert.equal((await store.readSessionInbox({ orgId: "org-b", userId: "u1", toSessionKey: "recipient" })).length, 0);
    assert.equal((await store.readSessionInbox({ orgId: "org-a", userId: "u1", toSessionKey: "recipient" })).length, 1);
  } finally {
    await listener.end().catch(() => undefined);
    await cleanup();
  }
});

test("routeSessionMessage: retries report persisted terminal state and preserve rejection reasons", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sender", "terminal-client", 0, "org-a");
    await registerSession(store, "u1", "recipient", "editor-client", 0, "org-a");
    const base = {
      orgId: "org-a",
      userId: "u1",
      fromSessionKey: "sender",
      toSessionKey: "recipient",
      kind: "text" as const,
      payload: { text: "terminal retry" },
    };

    const applied = await store.routeSessionMessage(
      { ...base, messageId: "terminal-applied" },
      { receiptIdGenerator: () => "receipt-applied" },
    );
    await store.transitionSessionMessages({
      orgId: "org-a", userId: "u1", toSessionKey: "recipient",
      ids: [applied.receipts[0]!.id], toStatus: "applied", at: iso(),
    });
    const appliedReplay = await store.routeSessionMessage({ ...base, messageId: "terminal-applied" });
    assert.equal(appliedReplay.state, "applied");
    assert.equal(appliedReplay.deliveries.length, 0);
    assert.equal(appliedReplay.accepted, 1);

    const declined = await store.routeSessionMessage(
      { ...base, messageId: "terminal-declined" },
      { receiptIdGenerator: () => "receipt-declined" },
    );
    await store.transitionSessionMessages({
      orgId: "org-a", userId: "u1", toSessionKey: "recipient",
      ids: [declined.receipts[0]!.id], toStatus: "declined", reason: "operator declined", at: iso(),
    });
    const declinedReplay = await store.routeSessionMessage({ ...base, messageId: "terminal-declined" });
    assert.equal(declinedReplay.state, "declined");
    assert.equal(declinedReplay.deliveries.length, 0);

    const queueFull = await store.routeSessionMessage(
      { ...base, messageId: "terminal-queue-full" },
      { receiptIdGenerator: () => "receipt-queue-full" },
    );
    const queueFullRows = await store.transitionSessionMessages({
      orgId: "org-a", userId: "u1", toSessionKey: "recipient",
      ids: [queueFull.receipts[0]!.id], toStatus: "queue_full",
      reason: "recipient safe-boundary queue is full", at: iso(),
    });
    assert.equal(queueFullRows[0]?.status, "queue_full");
    assert.equal(queueFullRows[0]?.statusReason, "recipient safe-boundary queue is full");
    assert.ok(queueFullRows[0]?.terminalAt);
    const queueFullReplay = await store.routeSessionMessage({ ...base, messageId: "terminal-queue-full" });
    assert.equal(queueFullReplay.state, "not-queued");
    assert.equal(queueFullReplay.rejectionReason, "queue_full");
    assert.equal(queueFullReplay.deliveries.length, 0);

    const expiredAt = "2026-08-11T00:00:00.000Z";
    await store.routeSessionMessage(
      { ...base, messageId: "terminal-expired" },
      { receiptIdGenerator: () => "receipt-expired", now: expiredAt },
    );
    await store.expireSessionMessages("2026-08-12T00:00:00.001Z");
    const expiredReplay = await store.routeSessionMessage({ ...base, messageId: "terminal-expired" });
    assert.equal(expiredReplay.state, "expired");
    assert.equal(expiredReplay.deliveries.length, 0);

    const rejectedInput = {
      ...base,
      messageId: "terminal-rejected",
      toSessionKey: "missing-recipient",
    };
    const rejected = await store.routeSessionMessage(rejectedInput);
    const rejectedReplay = await store.routeSessionMessage(rejectedInput);
    assert.equal(rejected.state, "not-queued");
    assert.equal(rejected.rejectionReason, "recipient_not_active");
    assert.equal(rejectedReplay.state, "not-queued");
    assert.equal(rejectedReplay.rejectionReason, "recipient_not_active");
    assert.equal(rejectedReplay.idempotentReplay, true);
  } finally {
    await cleanup();
  }
});

test("routeSessionMessage: persists sender provenance from the authenticated active-session row", async () => {
  const { store, cleanup } = await createTestStore();
  const now = iso();
  try {
    await store.registerActiveSession({
      orgId: "org-a",
      userId: "u1",
      sessionKey: "sender",
      clientKind: "brainrouter-cli",
      workspaceRoot: "/repos/authenticated",
      startedAt: now,
      lastHeartbeatAt: now,
      metadata: {
        deviceId: "11111111-1111-4111-8111-111111111111",
        title: "Authenticated sender",
      },
    });
    await registerSession(store, "u1", "recipient", "editor-client", 0, "org-a");
    const input = {
      orgId: "org-a",
      userId: "u1",
      messageId: "provenance-message",
      fromSessionKey: "sender",
      toSessionKey: "recipient",
      kind: "text" as const,
      payload: {
        text: "This content remains untrusted.",
        senderDeviceId: "99999999-9999-4999-8999-999999999999",
        senderClientKind: "forged-client",
        senderTitle: "Forged sender",
        senderWorkspaceRoot: "/repos/forged",
      },
    };

    const first = await store.routeSessionMessage(input, { receiptIdGenerator: () => "provenance-receipt" });
    assert.deepEqual(first.receipts[0]?.payload, {
      text: "This content remains untrusted.",
      senderDeviceId: "11111111-1111-4111-8111-111111111111",
      senderClientKind: "brainrouter-cli",
      senderTitle: "Authenticated sender",
      senderWorkspaceRoot: "/repos/authenticated",
    });

    const replay = await store.routeSessionMessage({
      ...input,
      payload: {
        ...input.payload,
        senderDeviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        senderTitle: "Another forgery",
      },
    });
    assert.equal(replay.idempotentReplay, true, "forged reserved fields are not message content");
    assert.deepEqual(replay.receipts[0]?.payload, first.receipts[0]?.payload);
  } finally {
    await cleanup();
  }
});

test("routeSessionMessage: queue depth and fanout limits remain atomic under contention", async () => {
  const { store, url, cleanup } = await createTestStore();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const key of ["sender-a", "sender-b", "target"]) {
      await registerSession(store, "u1", key, "terminal-client", 0, "org-a");
    }
    const now = iso();
    const expires = iso(60 * 60_000);
    await client.query(
      `INSERT INTO session_inbox (
         id, org_id, user_id, message_id, from_session_key, to_session_key,
         kind, payload_json, status, created_at, updated_at, expires_at
       )
       SELECT 'seed-' || n, 'org-a', 'u1', 'seed-message-' || n,
              'seed-sender-' || n, 'target', 'text', '{}', 'pending', $1, $1, $2
         FROM generate_series(1, 99) AS n`,
      [now, expires],
    );

    const [left, right] = await Promise.all([
      store.routeSessionMessage({
        orgId: "org-a", userId: "u1", messageId: "race-a", fromSessionKey: "sender-a",
        toSessionKey: "target", kind: "text", payload: { side: "a" },
      }),
      store.routeSessionMessage({
        orgId: "org-a", userId: "u1", messageId: "race-b", fromSessionKey: "sender-b",
        toSessionKey: "target", kind: "text", payload: { side: "b" },
      }),
    ]);
    assert.deepEqual(
      [left.receipts[0]?.status, right.receipts[0]?.status].sort(),
      ["pending", "queue_full"],
    );
    const depth = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM session_inbox WHERE org_id = 'org-a' AND user_id = 'u1' AND to_session_key = 'target' AND status IN ('pending', 'held')",
    );
    assert.equal(Number(depth.rows[0].count), 100);

    await client.query(
      `INSERT INTO active_sessions (
         org_id, session_key, user_id, client_kind, workspace_root,
         started_at, last_heartbeat_at, metadata_json, claim_token, claim_expires_at
       )
       SELECT 'org-a', 'fan-' || n, 'u1', 'fan-client', '/repos/alpha', $1, $1, '{}',
              'trusted-fan-' || n, (CURRENT_TIMESTAMP + interval '2 minutes')::text
         FROM generate_series(1, 101) AS n`,
      [now],
    );
    const fanout = await store.routeSessionMessage({
      orgId: "org-a", userId: "u1", messageId: "too-wide", fromSessionKey: "sender-a",
      toSessionKey: "*", kind: "text", payload: { text: "wide" },
    });
    assert.equal(fanout.rejectionReason, "fanout_limit_exceeded");
    assert.equal(fanout.receipts.length, 1);
    assert.equal(fanout.receipts[0]?.status, "rejected");
  } finally {
    await client.end().catch(() => undefined);
    await cleanup();
  }
});

test("sendSessionMessage: clientKind:* broadcasts only to active peers of that kind", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "sk-sender", "terminal-client");
    await registerSession(store, "u1", "sk-bc-1", "brainrouter-cli");
    await registerSession(store, "u1", "sk-bc-2", "brainrouter-cli");
    await registerSession(store, "u1", "sk-other-1", "editor-client");
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
    await registerSession(store, "u1", "sk-sender", "terminal-client");
    await registerSession(store, "u1", "sk-a", "brainrouter-cli");
    await registerSession(store, "u1", "sk-b", "editor-client");
    await registerSession(store, "u1", "sk-c", "review-client");
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
    await registerSession(store, "u1", "sk-sender", "terminal-client");
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
    await registerSession(store, "u1", "from", "terminal-client");
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
      { idGenerator: () => "m1", now: iso(-3_000) },
    );
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-recip",
        kind: "text",
        payload: { i: 2 },
      },
      { idGenerator: () => "m2", now: iso(-2_000) },
    );
    await store.sendSessionMessage(
      {
        userId: "u1",
        fromSessionKey: "from",
        toSessionKey: "sk-recip",
        kind: "text",
        payload: { i: 3 },
      },
      { idGenerator: () => "m3", now: iso(-1_000) },
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
    await registerSession(store, "u1", "from", "terminal-client");
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

test("sweepSessionInbox: expires pending rows and deletes terminal receipts after retention", async () => {
  const { store, cleanup } = await createTestStore();
  try {
    await registerSession(store, "u1", "f", "terminal-client");
    await registerSession(store, "u1", "sk-r", "brainrouter-cli");

    // Two old pending and two old applied rows. Pending rows become durable
    // expiry receipts; applied rows have already exceeded terminal retention.
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

    // The legacy threshold argument cannot shorten the seven-day policy.
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
    assert.ok(remaining.every((row) => row.status === "expired"));
  } finally {
    await cleanup();
  }
});
