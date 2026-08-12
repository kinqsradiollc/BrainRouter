/**
 * ADR-034 distributed-claim acceptance: independent Brain processes fence one
 * logical session, route one applicable wake, and reject every stale token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { ActiveSessionRecord } from "@kinqs/brainrouter-types";
import { PostgresMemoryStore } from "../memory/store/postgres/PostgresMemoryStore.js";
import { SessionDeliveryHub } from "../services/sessionDeliveryHub.js";
import { createTestStore } from "./helpers/pgTestStore.js";

const ORG_ID = "org-claim-race";
const USER_ID = "claim-user";
const SESSION_KEY = "shared-session";

function record(sessionKey: string, clientKind: string): ActiveSessionRecord {
  const now = new Date().toISOString();
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    sessionKey,
    clientKind,
    workspaceRoot: "/workspace",
    startedAt: now,
    lastHeartbeatAt: now,
    metadata: {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for session wake");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("two brain processes fence one session claim and only the current owner receives an applicable wake", async () => {
  const handle = await createTestStore({ vecDim: 0 });
  const storeA = handle.store;
  const storeB = new PostgresMemoryStore(handle.url);
  const raw = new pg.Client({ connectionString: handle.url });
  const hubA = new SessionDeliveryHub();
  const hubB = new SessionDeliveryHub();
  const feeds: Array<ReturnType<PostgresMemoryStore["subscribeSessionMessageNotifications"]>> = [];

  try {
    await storeB.init();
    await raw.connect();

    const contenders = [
      { token: "connection-a", attempt: "attempt-a", store: storeA, hub: hubA, kind: "process-a" },
      { token: "connection-b", attempt: "attempt-b", store: storeB, hub: hubB, kind: "process-b" },
    ] as const;

    // Process-local hubs cannot see each other, so both reservations succeed.
    for (const contender of contenders) {
      assert.equal(
        contender.hub.reserve(contender.token, ORG_ID, USER_ID, SESSION_KEY, contender.attempt),
        true,
      );
    }

    const claims = await Promise.allSettled(contenders.map((contender) =>
      contender.store.registerActiveSession(
        record(SESSION_KEY, contender.kind),
        { token: contender.token },
      ),
    ));
    const winnerIndex = claims.findIndex((result) => result.status === "fulfilled");
    const loserIndex = claims.findIndex((result) => result.status === "rejected");
    assert.notEqual(winnerIndex, -1, "one process must acquire the database claim");
    assert.notEqual(loserIndex, -1, "one process must lose the database claim");
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      (claims[loserIndex] as PromiseRejectedResult).reason?.code,
      "ACTIVE_SESSION_CLAIM_CONFLICT",
    );

    const winner = contenders[winnerIndex]!;
    const loser = contenders[loserIndex]!;
    const staleWakes: string[] = [];
    const currentWakes: string[] = [];
    assert.equal(winner.hub.commitReservation({
      connectionId: winner.token,
      orgId: ORG_ID,
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      notify: async (wake) => { staleWakes.push(...wake.messageIds); },
    }, winner.attempt), true);
    loser.hub.releaseReservation(loser.token, ORG_ID, USER_ID, SESSION_KEY, loser.attempt);
    assert.equal(await storeA.ownsActiveSessionClaim(ORG_ID, USER_ID, SESSION_KEY, winner.token), true);
    assert.equal(await storeB.ownsActiveSessionClaim(ORG_ID, USER_ID, SESSION_KEY, loser.token), false);

    // Expiry is a database-clocked lease. Move only the stored lease into the
    // past, then prove the other process can atomically take over while the old
    // process still retains its stale in-memory binding.
    await raw.query(
      `UPDATE active_sessions SET claim_expires_at = (CURRENT_TIMESTAMP - interval '1 second')::text
        WHERE org_id = $1 AND user_id = $2 AND session_key = $3 AND claim_token = $4`,
      [ORG_ID, USER_ID, SESSION_KEY, winner.token],
    );
    assert.equal(await winner.store.ownsActiveSessionClaim(ORG_ID, USER_ID, SESSION_KEY, winner.token), false);
    await loser.store.registerActiveSession(record(SESSION_KEY, loser.kind), { token: loser.token });
    assert.equal(await storeA.sweepActiveSessions(0), 0,
      "heartbeat cleanup must not delete an unexpired database claim");
    assert.equal(loser.hub.reserve(loser.token, ORG_ID, USER_ID, SESSION_KEY, "takeover"), true);
    assert.equal(loser.hub.commitReservation({
      connectionId: loser.token,
      orgId: ORG_ID,
      userId: USER_ID,
      sessionKey: SESSION_KEY,
      notify: async (wake) => { currentWakes.push(...wake.messageIds); },
    }, "takeover"), true);

    assert.equal(await winner.store.heartbeatActiveSession(
      USER_ID,
      SESSION_KEY,
      new Date().toISOString(),
      null,
      ORG_ID,
      { token: winner.token },
    ), false, "an expired owner cannot renew after another process takes over");
    assert.equal(
      await winner.store.unregisterActiveSession(USER_ID, SESSION_KEY, ORG_ID, winner.token),
      false,
      "stale disconnect cleanup must not delete the current owner",
    );

    const senderToken = "sender-connection";
    const skewedSender = record("sender-session", "sender-process");
    skewedSender.lastHeartbeatAt = "1900-01-01T00:00:00.000Z";
    const registeredSender = await storeA.registerActiveSession(skewedSender, { token: senderToken });
    assert.notEqual(
      registeredSender.lastHeartbeatAt,
      skewedSender.lastHeartbeatAt,
      "claimed registration must stamp its heartbeat from the database clock",
    );
    assert.equal(await storeA.heartbeatActiveSession(
      USER_ID,
      "sender-session",
      "2099-01-01T00:00:00.000Z",
      null,
      ORG_ID,
      { token: senderToken },
    ), true);
    const heartbeatClock = await raw.query<{ database_clocked: boolean }>(
      `SELECT ABS(EXTRACT(EPOCH FROM (
         last_heartbeat_at::timestamptz - CURRENT_TIMESTAMP
       ))) < 5 AS database_clocked
         FROM active_sessions
        WHERE org_id = $1 AND user_id = $2 AND session_key = $3`,
      [ORG_ID, USER_ID, "sender-session"],
    );
    assert.equal(heartbeatClock.rows[0]?.database_clocked, true,
      "claimed heartbeat must ignore a skewed process timestamp");

    feeds.push(storeA.subscribeSessionMessageNotifications(async (notification) => {
      await hubA.notifyStoreNotification(notification, (binding) => storeA.ownsActiveSessionClaim(
        binding.orgId, binding.userId, binding.sessionKey, binding.connectionId,
      ));
    }));
    feeds.push(storeB.subscribeSessionMessageNotifications(async (notification) => {
      await hubB.notifyStoreNotification(notification, (binding) => storeB.ownsActiveSessionClaim(
        binding.orgId, binding.userId, binding.sessionKey, binding.connectionId,
      ));
    }));
    await Promise.all(feeds.map((feed) => feed.ready));

    const sent = await storeA.routeSessionMessage(
      {
        orgId: ORG_ID,
        userId: USER_ID,
        messageId: "distributed-wake",
        fromSessionKey: "sender-session",
        toSessionKey: SESSION_KEY,
        kind: "text",
        payload: { text: "wake the current process only" },
        senderClaimToken: senderToken,
      },
      {
        // Message timestamps remain injectable, but must never become the
        // authority clock for sender/recipient liveness.
        now: "2099-01-01T00:00:00.000Z",
      },
    );
    assert.equal(sent.accepted, 1);
    await waitFor(() => currentWakes.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(staleWakes, [], "the stale process must not push after lease takeover");
    assert.deepEqual(currentWakes, [sent.receipts[0]!.id]);
    assert.equal(winner.hub.owns(winner.token, ORG_ID, USER_ID, SESSION_KEY), false,
      "a failed database claim validation reaps the stale local binding");

    const staleSend = await winner.store.routeSessionMessage({
      orgId: ORG_ID,
      userId: USER_ID,
      messageId: "stale-send",
      fromSessionKey: SESSION_KEY,
      toSessionKey: "sender-session",
      kind: "text",
      payload: { text: "must not route" },
      senderClaimToken: winner.token,
    });
    assert.equal(staleSend.rejectionReason, "sender_not_active");
    assert.deepEqual(await winner.store.readSessionInbox({
      orgId: ORG_ID,
      userId: USER_ID,
      toSessionKey: SESSION_KEY,
      claimToken: winner.token,
    }), []);
    assert.deepEqual(await winner.store.transitionSessionMessages({
      orgId: ORG_ID,
      userId: USER_ID,
      toSessionKey: SESSION_KEY,
      ids: [sent.receipts[0]!.id],
      toStatus: "applied",
      at: new Date().toISOString(),
      claimToken: winner.token,
    }), []);

    const currentInbox = await loser.store.readSessionInbox({
      orgId: ORG_ID,
      userId: USER_ID,
      toSessionKey: SESSION_KEY,
      claimToken: loser.token,
    });
    assert.deepEqual(currentInbox.map((row) => row.id), [sent.receipts[0]!.id]);
    const applied = await loser.store.transitionSessionMessages({
      orgId: ORG_ID,
      userId: USER_ID,
      toSessionKey: SESSION_KEY,
      ids: [sent.receipts[0]!.id],
      toStatus: "applied",
      at: new Date().toISOString(),
      claimToken: loser.token,
    });
    assert.equal(applied.length, 1);

    assert.deepEqual(await storeA.readSessionMessageReceipts({
      orgId: ORG_ID,
      userId: USER_ID,
      fromSessionKey: "sender-session",
      claimToken: loser.token,
    }), []);
    const receipts = await storeA.readSessionMessageReceipts({
      orgId: ORG_ID,
      userId: USER_ID,
      fromSessionKey: "sender-session",
      claimToken: senderToken,
    });
    assert.equal(receipts[0]?.status, "applied");
    assert.equal(await storeA.ackSessionMessageReceipts({
      orgId: ORG_ID,
      userId: USER_ID,
      fromSessionKey: "sender-session",
      ids: [sent.receipts[0]!.id],
      at: new Date().toISOString(),
      claimToken: loser.token,
    }), 0);
    assert.equal(await storeA.ackSessionMessageReceipts({
      orgId: ORG_ID,
      userId: USER_ID,
      fromSessionKey: "sender-session",
      ids: [sent.receipts[0]!.id],
      at: new Date().toISOString(),
      claimToken: senderToken,
    }), 1);

    assert.equal(await loser.store.releaseActiveSessionClaims(loser.token), 1);
    await winner.store.registerActiveSession(record(SESSION_KEY, winner.kind), { token: winner.token });
    assert.equal(await winner.store.ownsActiveSessionClaim(ORG_ID, USER_ID, SESSION_KEY, winner.token), true,
      "a released address can be reclaimed without waiting for lease expiry");
  } finally {
    await Promise.all(feeds.map((feed) => feed.close().catch(() => undefined)));
    await raw.end().catch(() => undefined);
    await storeB.close().catch(() => undefined);
    await handle.cleanup();
  }
});
