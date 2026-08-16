/**
 * ADR-034 composite acceptance harness.
 *
 * This is deliberately one isolated, same-machine flow rather than a set of
 * mocked unit assertions. It composes the authenticated loopback transport,
 * the model-safe steering boundary, two real MCP connections, an isolated
 * Postgres database, and the transaction-coupled notification feed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  SessionMessageNotificationSchema,
} from "@kinqs/brainrouter-core/mcp";
import {
  admitSessionMessage,
  approveHeldSessionMessage,
  getLocalMessagingDeviceId,
  markHeldSessionMessageApplied,
  sendLocalSessionMessage,
  startLocalSessionTransport,
  type LocalSessionMessage,
  type PeerSessionSteeringInput,
} from "@kinqs/brainrouter-core/session";
import { applyPendingSteeringAtBoundary } from "../../../packages/core/dist/agent/runtime/steering.js";
import type {
  SessionInboxRecord,
  SessionMessageStoreNotification,
} from "@kinqs/brainrouter-types";
import { closeMemoryEngine, getMemoryEngine } from "../memory/engine.js";
import { Registry } from "../registry.js";
import { SessionDeliveryHub } from "../services/sessionDeliveryHub.js";
import { buildMcpServer } from "../transport/mcpServer.js";
import { createTestStore, type TestStoreHandle } from "./helpers/pgTestStore.js";

const ORG_ID = "adr034-acceptance-org";
const USER_ID = "adr034-acceptance-user";
const REMOTE_MESSAGE_ID = "adr034-remote-message-1";

interface EnvironmentSnapshot {
  BRAINROUTER_DATABASE_URL?: string;
  DATABASE_URL?: string;
  BRAINROUTER_HOME?: string;
  BRAINROUTER_JOB_RUNNER?: string;
}

interface ConnectedMcpClient {
  client: Client;
  close(): Promise<void>;
}

interface RegisterResult {
  session: {
    orgId: string | null;
    userId: string;
    sessionKey: string;
    deviceId?: string;
    messageWakeVersion?: 1;
  };
}

interface SendResult {
  messageId: string;
  state: "persisted-unseen" | "held" | "applied" | "declined" | "expired" | "not-queued" | "mixed";
  accepted: number;
  rejected: number;
  idempotentReplay: boolean;
  recipients: Array<{
    sessionKey: string;
    inboxId: string;
    status: string;
    wake?: "pushed" | "poll-fallback";
  }>;
}

interface InboxReadResult {
  messages: SessionInboxRecord[];
}

interface InboxAckResult {
  updated: number;
  status: string;
  messages: SessionInboxRecord[];
}

interface ReceiptsResult {
  receipts: SessionInboxRecord[];
}

test("ADR-034 local-offline and remote durable delivery apply once at safe boundaries", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brainrouter-adr034-acceptance-"));
  const environment = snapshotEnvironment();
  let storeHandle: TestStoreHandle | undefined;
  const remoteClients: ConnectedMcpClient[] = [];
  let remoteRecipientTransport: Awaited<ReturnType<typeof startLocalSessionTransport>> | undefined;
  let notificationFeed: ReturnType<TestStoreHandle["store"]["subscribeSessionMessageNotifications"]> | undefined;

  try {
    await t.test("two local sessions deliver with Brain unavailable and wait for a safe boundary", async () => {
      const localHome = path.join(tempRoot, "local-install");
      const localWorkspace = path.join(tempRoot, "local-workspace");
      fs.mkdirSync(localWorkspace, { recursive: true });
      process.env.BRAINROUTER_HOME = localHome;
      process.env.BRAINROUTER_DATABASE_URL = "postgres://127.0.0.1:1/brain-unavailable";
      delete process.env.DATABASE_URL;

      const notifications: LocalSessionMessage[] = [];
      const sender = await startLocalSessionTransport({
        sessionKey: "adr034-local-sender",
        clientKind: "cli",
        state: "idle",
      });
      const recipient = await startLocalSessionTransport({
        sessionKey: "adr034-local-recipient",
        clientKind: "desktop",
        state: "working",
        workspaceRoot: localWorkspace,
        onMessageAvailable: (message) => notifications.push(message),
      });

      try {
        assert.equal(sender.registration().deviceId, recipient.registration().deviceId);
        assert.equal(recipient.registration().state, "working");

        const input = {
          id: "adr034-local-message-1",
          senderSessionKey: "adr034-local-sender",
          text: "Re-check the release boundary before continuing.",
          createdAt: Date.now(),
        };
        const firstReceipt = await sendLocalSessionMessage("adr034-local-recipient", input);
        const retryReceipt = await sendLocalSessionMessage("adr034-local-recipient", input);
        assert.equal(firstReceipt.queued, true);
        assert.equal(retryReceipt.queued, true);
        if (!firstReceipt.queued || !retryReceipt.queued) assert.fail("local delivery was not queued");
        assert.equal(firstReceipt.duplicate, false);
        assert.equal(retryReceipt.duplicate, true);
        assert.equal(recipient.pendingCount(), 1);
        assert.equal(notifications.length, 1);

        const history: Array<Record<string, unknown>> = [];
        const transcript: Array<Record<string, unknown>> = [];
        const [queuedMessage] = recipient.drain().messages;
        assert.ok(queuedMessage);
        const admission = admitSessionMessage(localWorkspace, queuedMessage, {
          workspaceFiles: "allow",
          shell: "confirm",
          computerUse: "denied",
          externalWrites: "confirm",
          remoteTools: "confirm",
        }, Date.now(), { transport: "local", clientKind: "cli", title: "Offline sender" });
        assert.equal(admission.decision, "held", "elevated recipient authority must hold peer content");
        const approved = approveHeldSessionMessage(
          localWorkspace,
          "adr034-local-recipient",
          queuedMessage.id,
        );
        assert.ok(approved.input, "explicit approval must produce one replayable steering input");
        const pending = [approved.input];
        let interruptRequests = 0;
        let boundaryApplications = 0;
        const boundaryPort = steeringPort(localWorkspace, "adr034-local-recipient", pending, history, transcript, () => {
          interruptRequests += 1;
        });

        assert.equal(history.length, 0, "a working recipient must not apply before a model-safe seam");
        assert.equal(interruptRequests, 0, "peer arrival must not request turn interruption");
        assert.equal(applyPendingSteeringAtBoundary(boundaryPort, {
          onStatusUpdate: () => undefined,
          onSteerApplied: () => {
            boundaryApplications += 1;
            markHeldSessionMessageApplied(
              localWorkspace,
              "adr034-local-recipient",
              queuedMessage.id,
            );
          },
        }), 1);
        assert.equal(applyPendingSteeringAtBoundary(boundaryPort, {
          onStatusUpdate: () => undefined,
          onSteerApplied: () => { boundaryApplications += 1; },
        }), 0);
        assert.equal(boundaryApplications, 1);
        assert.equal(interruptRequests, 0);
        assert.equal(history.some((entry) => entry.role === "user"), false);
        assert.deepEqual(
          history.filter((entry) => entry.name === "peer-session").map((entry) => entry.trust),
          ["untrusted-session"],
        );
        assert.equal(transcript.filter((entry) => entry.name === "peer-session").length, 1);
      } finally {
        await recipient.close();
        await sender.close();
      }
    });

    restoreEnvironment(environment);
    storeHandle = await createTestStore({ vecDim: 0 });
    await storeHandle.store.createUser(
      USER_ID,
      "adr034-acceptance-test-key",
      "ADR-034 acceptance",
      true,
    );
    process.env.BRAINROUTER_DATABASE_URL = storeHandle.url;
    process.env.DATABASE_URL = storeHandle.url;
    process.env.BRAINROUTER_JOB_RUNNER = "off";
    await getMemoryEngine().ready;

    await t.test("isolated installs use durable MCP delivery, replay a lost wake, and apply once", async () => {
      const senderHome = path.join(tempRoot, "remote-install-sender");
      const recipientHome = path.join(tempRoot, "remote-install-recipient");
      process.env.BRAINROUTER_HOME = senderHome;
      const senderDeviceId = getLocalMessagingDeviceId();
      process.env.BRAINROUTER_HOME = recipientHome;
      const recipientDeviceId = getLocalMessagingDeviceId();
      assert.notEqual(senderDeviceId, recipientDeviceId, "isolated installs must mint distinct persisted identities");
      process.env.BRAINROUTER_HOME = senderHome;
      assert.equal(getLocalMessagingDeviceId(), senderDeviceId, "an install identity must be stable on reread");
      process.env.BRAINROUTER_HOME = recipientHome;
      assert.equal(getLocalMessagingDeviceId(), recipientDeviceId, "the second install identity must be stable on reread");

      const hub = new SessionDeliveryHub();
      const storeNotifications: SessionMessageStoreNotification[] = [];
      notificationFeed = storeHandle!.store.subscribeSessionMessageNotifications(async (notification) => {
        storeNotifications.push(notification);
        await hub.notifyStoreNotification(notification);
      });
      await notificationFeed.ready;

      const recipientPeer = await connectMcp("adr034-recipient-connection", hub);
      const senderPeer = await connectMcp("adr034-sender-connection", hub);
      remoteClients.push(recipientPeer, senderPeer);

      const droppedRecipientWakes: string[] = [];
      const senderTerminalWakes: string[] = [];
      recipientPeer.client.setNotificationHandler(SessionMessageNotificationSchema, (notification) => {
        // Deliberately drop the ephemeral hint. The durable inbox must replay it.
        droppedRecipientWakes.push(...notification.params.messageIds);
      });
      senderPeer.client.setNotificationHandler(SessionMessageNotificationSchema, (notification) => {
        senderTerminalWakes.push(...notification.params.messageIds);
      });

      const recipientRegistration = toolJson<RegisterResult>(await recipientPeer.client.callTool({
        name: "session_register",
        arguments: {
          sessionKey: "adr034-remote-recipient",
          clientKind: "brainrouter-desktop",
          workspaceRoot: path.join(tempRoot, "remote-recipient-workspace"),
          deviceId: recipientDeviceId,
          state: "working",
          messageWakeVersion: 1,
        },
      }));
      const senderRegistration = toolJson<RegisterResult>(await senderPeer.client.callTool({
        name: "session_register",
        arguments: {
          sessionKey: "adr034-remote-sender",
          clientKind: "brainrouter-cli",
          workspaceRoot: path.join(tempRoot, "remote-sender-workspace"),
          deviceId: senderDeviceId,
          title: "Authenticated sender",
          titleSource: "human",
          state: "idle",
          messageWakeVersion: 1,
        },
      }));
      assert.deepEqual(
        [senderRegistration.session.orgId, senderRegistration.session.userId, senderRegistration.session.deviceId],
        [ORG_ID, USER_ID, senderDeviceId],
      );
      assert.deepEqual(
        [recipientRegistration.session.orgId, recipientRegistration.session.userId, recipientRegistration.session.deviceId],
        [ORG_ID, USER_ID, recipientDeviceId],
      );

      const persistedSessions = await storeHandle!.store.listActiveSessions({
        orgId: ORG_ID,
        userId: USER_ID,
        includeStale: true,
      });
      assert.deepEqual(
        persistedSessions.map((session) => [session.sessionKey, session.deviceId]).sort(),
        [
          ["adr034-remote-recipient", recipientDeviceId],
          ["adr034-remote-sender", senderDeviceId],
        ],
      );

      const sendArguments = {
        from: "adr034-remote-sender",
        to: "adr034-remote-recipient",
        messageId: REMOTE_MESSAGE_ID,
        kind: "text",
        payload: {
          text: "Carry this durable steering message across the lost wake.",
          senderDeviceId: "99999999-9999-4999-8999-999999999999",
          senderClientKind: "forged-client",
          senderTitle: "Forged sender",
          senderWorkspaceRoot: "/repos/forged",
        },
      };
      const firstSend = toolJson<SendResult>(await senderPeer.client.callTool({
        name: "session_send",
        arguments: sendArguments,
      }));
      const retrySend = toolJson<SendResult>(await senderPeer.client.callTool({
        name: "session_send",
        arguments: sendArguments,
      }));
      assert.equal(firstSend.state, "persisted-unseen");
      assert.equal(firstSend.accepted, 1);
      assert.equal(firstSend.idempotentReplay, false);
      assert.equal(retrySend.accepted, 1);
      assert.equal(retrySend.idempotentReplay, true);
      assert.equal(firstSend.recipients[0]?.inboxId, retrySend.recipients[0]?.inboxId);
      const inboxId = firstSend.recipients[0]?.inboxId;
      assert.ok(inboxId);

      await waitUntil(() =>
        storeNotifications.some((notification) => notification.inboxId === inboxId && notification.status === "pending"),
      );
      assert.equal(
        storeNotifications.filter((notification) => notification.inboxId === inboxId && notification.status === "pending").length,
        1,
        "an idempotent retry must not persist or notify a second row",
      );
      assert.ok(
        droppedRecipientWakes.filter((id) => id === inboxId).length >= 2,
        "the live hint and retry may wake more than once, so host admission must deduplicate",
      );

      const firstPeek = toolJson<InboxReadResult>(await recipientPeer.client.callTool({
        name: "session_inbox_read",
        arguments: { sessionKey: "adr034-remote-recipient", peek: true },
      }));
      const replayPeek = toolJson<InboxReadResult>(await recipientPeer.client.callTool({
        name: "session_inbox_read",
        arguments: { sessionKey: "adr034-remote-recipient", peek: true },
      }));
      assert.deepEqual(firstPeek.messages.map((message) => message.id), [inboxId]);
      assert.deepEqual(replayPeek.messages.map((message) => message.id), [inboxId]);
      assert.equal(firstPeek.messages[0]?.deliveredAt, null);
      assert.deepEqual(firstPeek.messages[0]?.payload, {
        text: "Carry this durable steering message across the lost wake.",
        senderDeviceId,
        senderClientKind: "brainrouter-cli",
        senderTitle: "Authenticated sender",
        senderWorkspaceRoot: path.join(tempRoot, "remote-sender-workspace"),
      }, "MCP delivery must replace forged sender fields with the authenticated active-session row");

      process.env.BRAINROUTER_HOME = recipientHome;
      const recipientWorkspace = path.join(tempRoot, "remote-recipient-workspace");
      fs.mkdirSync(recipientWorkspace, { recursive: true });
      remoteRecipientTransport = await startLocalSessionTransport({
        sessionKey: "adr034-remote-recipient",
        clientKind: "desktop",
        state: "working",
        workspaceRoot: recipientWorkspace,
      });
      const firstAdmission = remoteRecipientTransport.acceptPeerMessage(
        remoteEnvelope(firstPeek.messages[0]!, senderDeviceId),
      );
      const replayAdmission = remoteRecipientTransport.acceptPeerMessage(
        remoteEnvelope(replayPeek.messages[0]!, senderDeviceId),
      );
      assert.equal(firstAdmission.queued, true);
      assert.equal(replayAdmission.queued, true);
      if (!firstAdmission.queued || !replayAdmission.queued) assert.fail("remote replay was not admitted");
      assert.equal(firstAdmission.duplicate, false);
      assert.equal(replayAdmission.duplicate, true);

      const remoteHistory: Array<Record<string, unknown>> = [];
      const remoteTranscript: Array<Record<string, unknown>> = [];
      const remotePending = remoteRecipientTransport.drain().messages.map((message) => {
        const admission = admitSessionMessage(recipientWorkspace, message, {
          workspaceFiles: "denied",
          shell: "confirm",
          computerUse: "denied",
          externalWrites: "confirm",
          remoteTools: "confirm",
        }, Date.now(), { transport: "remote", clientKind: "cli", title: "Durable sender" });
        assert.equal(admission.decision, "apply");
        if (admission.decision !== "apply") assert.fail("safe remote message was not admitted");
        return admission.input;
      });
      let remoteApplications = 0;
      const remoteBoundary = steeringPort(
        recipientWorkspace,
        "adr034-remote-recipient",
        remotePending,
        remoteHistory,
        remoteTranscript,
      );
      assert.equal(remoteHistory.length, 0);
      assert.equal(applyPendingSteeringAtBoundary(remoteBoundary, {
        onStatusUpdate: () => undefined,
        onSteerApplied: () => { remoteApplications += 1; },
      }), 1);
      assert.equal(applyPendingSteeringAtBoundary(remoteBoundary, {
        onStatusUpdate: () => undefined,
        onSteerApplied: () => { remoteApplications += 1; },
      }), 0);
      assert.equal(remoteApplications, 1);
      assert.equal(remoteHistory.filter((entry) => entry.name === "peer-session").length, 1);
      assert.equal(remoteHistory.some((entry) => entry.role === "user"), false);

      const acknowledgement = toolJson<InboxAckResult>(await recipientPeer.client.callTool({
        name: "session_inbox_ack",
        arguments: {
          sessionKey: "adr034-remote-recipient",
          ids: [inboxId],
          status: "applied",
        },
      }));
      const acknowledgementRetry = toolJson<InboxAckResult>(await recipientPeer.client.callTool({
        name: "session_inbox_ack",
        arguments: {
          sessionKey: "adr034-remote-recipient",
          ids: [inboxId],
          status: "applied",
        },
      }));
      assert.equal(acknowledgement.updated, 1);
      assert.equal(acknowledgement.messages[0]?.status, "applied");
      assert.equal(acknowledgementRetry.updated, 0);

      await waitUntil(() =>
        storeNotifications.some((notification) => notification.inboxId === inboxId && notification.status === "applied") &&
        senderTerminalWakes.includes(inboxId),
      );
      assert.equal(
        storeNotifications.filter((notification) => notification.inboxId === inboxId && notification.status === "applied").length,
        1,
        "an acknowledgement retry must not emit a second terminal transition",
      );

      const receipts = toolJson<ReceiptsResult>(await senderPeer.client.callTool({
        name: "session_receipts",
        arguments: { sessionKey: "adr034-remote-sender", messageId: REMOTE_MESSAGE_ID },
      }));
      assert.equal(receipts.receipts.length, 1);
      assert.deepEqual(
        [receipts.receipts[0]?.id, receipts.receipts[0]?.status, receipts.receipts[0]?.messageId],
        [inboxId, "applied", REMOTE_MESSAGE_ID],
      );

      const pendingAfterApply = toolJson<InboxReadResult>(await recipientPeer.client.callTool({
        name: "session_inbox_read",
        arguments: { sessionKey: "adr034-remote-recipient", peek: true },
      }));
      assert.deepEqual(pendingAfterApply.messages, []);
    });
  } finally {
    if (remoteRecipientTransport) await remoteRecipientTransport.close().catch(() => undefined);
    await Promise.all(remoteClients.splice(0).map((peer) => peer.close().catch(() => undefined)));
    if (notificationFeed) await notificationFeed.close().catch(() => undefined);
    await closeMemoryEngine().catch(() => undefined);
    if (storeHandle) await storeHandle.cleanup().catch(() => undefined);
    restoreEnvironment(environment);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function steeringPort(
  workspaceRoot: string,
  sessionKey: string,
  pending: PeerSessionSteeringInput[],
  history: Array<Record<string, unknown>>,
  transcript: Array<Record<string, unknown>>,
  requestInterrupt: () => void = () => undefined,
) {
  return {
    workspaceRoot,
    sessionKey,
    chatHistory: history,
    consumePendingSteering: () => pending.splice(0),
    restorePendingSteering: (inputs: PeerSessionSteeringInput[]) => {
      pending.unshift(...inputs);
    },
    recordTranscript: (message: Record<string, unknown>) => transcript.push(message),
    // Deliberately present a trap method: the safe-boundary service must not use
    // interrupt-style delivery for peer input.
    requestInterrupt,
  };
}

function remoteEnvelope(row: SessionInboxRecord, senderDeviceId: string) {
  const text = row.payload.text;
  if (typeof text !== "string") assert.fail("remote text payload was not a string");
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Number.NaN;
  if (!Number.isSafeInteger(expiresAt)) assert.fail("remote inbox expiry was not an absolute timestamp");
  return {
    id: row.id,
    senderSessionKey: row.fromSessionKey,
    senderDeviceId,
    targetSessionKey: row.toSessionKey,
    text,
    createdAt: Date.parse(row.createdAt),
    expiresAt,
  };
}

async function connectMcp(
  connectionId: string,
  hub: SessionDeliveryHub,
): Promise<ConnectedMcpClient> {
  const registry = new Registry({ globalRoot: "/nonexistent", localRoot: "/nonexistent" });
  const server = buildMcpServer(registry, {
    defaultOrgId: ORG_ID,
    defaultUserId: USER_ID,
    connectionId,
    sessionDeliveryHub: hub,
  });
  const client = new Client({ name: connectionId, version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      hub.disconnect(connectionId);
      await client.close();
      await server.close();
    },
  };
}

function toolJson<T>(result: unknown): T {
  assert.ok(result && typeof result === "object");
  const value = result as { isError?: boolean; content?: unknown[] };
  assert.notEqual(value.isError, true, toolErrorText(value.content));
  assert.ok(Array.isArray(value.content) && value.content.length > 0);
  const first = value.content[0];
  assert.ok(first && typeof first === "object");
  const block = first as { type?: string; text?: string };
  assert.equal(block.type, "text");
  if (typeof block.text !== "string") assert.fail("MCP tool result did not contain text");
  return JSON.parse(block.text) as T;
}

function toolErrorText(content: unknown[] | undefined): string {
  const first = content?.[0];
  return first && typeof first === "object" && "text" in first
    ? String((first as { text: unknown }).text)
    : "MCP tool returned an error";
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function snapshotEnvironment(): EnvironmentSnapshot {
  return {
    BRAINROUTER_DATABASE_URL: process.env.BRAINROUTER_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    BRAINROUTER_HOME: process.env.BRAINROUTER_HOME,
    BRAINROUTER_JOB_RUNNER: process.env.BRAINROUTER_JOB_RUNNER,
  };
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of Object.keys(snapshot) as Array<keyof EnvironmentSnapshot>) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
