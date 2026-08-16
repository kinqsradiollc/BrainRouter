/**
 * ADR-034 production-adapter composition: Brain-offline CLI-to-Desktop delivery
 * must hold, approve, and apply once without creating a user-role message.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Agent } from '../packages/core/src/agent/agent.js';
import { applyPendingSteeringAtBoundary } from '../packages/core/src/agent/runtime/steering.js';
import {
  listHeldSessionMessages,
  type LocalSessionMessage,
  type PeerSessionSender,
} from '../packages/core/src/session/index.js';
import { attachFederation } from '../brainrouter-cli/src/runtime/federation/federationRegistration.js';
import { DesktopSessionMessaging } from '../brainrouter-desktop/electron/host/sessionMessaging.js';

test('ADR-034 production CLI and Desktop adapters deliver locally, hold, approve, and apply once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-adr034-hosts-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  const previousHome = process.env.BRAINROUTER_HOME;
  process.env.BRAINROUTER_HOME = home;

  const offlinePool = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'Brain is offline.' }] }),
    getActiveBrainrouterServerId: () => undefined,
  };
  const recipient = new Agent(
    offlinePool as never,
    { provider: 'openai', apiKey: 'test', model: 'test-model' },
    {
      workspaceRoot: workspace,
      launchCwd: workspace,
      sessionKey: 'desktop:acceptance-recipient',
      accessMode: 'shell',
      silent: true,
    },
  );
  const delivered: string[] = [];
  const desktop = new DesktopSessionMessaging({
    workspaceRoot: workspace,
    mcp: offlinePool,
    getActiveAgent: () => recipient,
    deliverPeer: (message: LocalSessionMessage, sender: PeerSessionSender) => {
      const { sessionKey: _sessionKey, deviceId: _deviceId, sentAt: _sentAt, ...details } = sender;
      try {
        recipient.requestPeerSessionSteer(message, details);
        delivered.push(message.id);
        return { accepted: true, state: 'steered' };
      } catch (error) {
        return {
          accepted: false,
          state: 'queue_full',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // This is the same generic confirmation seam the production host backs
    // with its InteractionBroker. Unsafe authority must reach it before Core.
    confirmHeld: async () => true,
    pollIntervalMs: 60_000,
  });
  let cli: Awaited<ReturnType<typeof attachFederation>> | undefined;

  try {
    await desktop.start(recipient);
    cli = await attachFederation({
      mcpClient: offlinePool as never,
      sessionKey: 'cli:acceptance-sender',
      workspaceRoot: workspace,
      intervalMs: 60_000,
      inboxIntervalMs: 60_000,
    });

    const peers = await cli.discoverSessions();
    assert.deepEqual(
      peers.routes.filter((route) => route.sessionKey === recipient.sessionKey)
        .map((route) => [route.clientKind, route.transport]),
      [['desktop', 'local']],
    );

    const receipt = await cli.sendMessage({
      targetSessionKey: recipient.sessionKey,
      kind: 'text',
      payload: { text: 'Verify the real host adapters before release.' },
      localText: 'Verify the real host adapters before release.',
      messageId: 'adr034-host-adapter-message',
    });
    assert.equal(receipt.accepted, true);
    if (!receipt.accepted) assert.fail(receipt.reason);
    assert.equal(receipt.transport, 'local');
    assert.equal(receipt.state, 'queued');

    await waitUntil(() => recipient.pendingSteeringCount === 1);
    const heldBeforeBoundary = listHeldSessionMessages(workspace, recipient.sessionKey)
      .find((row) => row.id === 'adr034-host-adapter-message');
    assert.equal(heldBeforeBoundary?.status, 'approved');
    assert.equal(heldBeforeBoundary?.appliedAt, undefined);
    assert.deepEqual(delivered, ['adr034-host-adapter-message']);

    let applied = 0;
    assert.equal(applyPendingSteeringAtBoundary(recipient, {
      onStatusUpdate: () => undefined,
      onSteerApplied: (input) => {
        applied += 1;
        if (input.source === 'peer-session') desktop.onPeerApplied(recipient.sessionKey, input.id);
      },
    }), 1);
    assert.equal(applyPendingSteeringAtBoundary(recipient, {
      onStatusUpdate: () => undefined,
      onSteerApplied: () => { applied += 1; },
    }), 0);
    assert.equal(applied, 1);
    await waitUntil(() => listHeldSessionMessages(workspace, recipient.sessionKey)
      .some((row) => row.id === 'adr034-host-adapter-message' && row.appliedAt !== undefined));
    assert.equal(recipient.chatHistory.some((entry) =>
      entry.role === 'user' && entry.content === 'Verify the real host adapters before release.'), false);
    assert.equal(recipient.chatHistory.filter((entry) =>
      entry.role === 'assistant' && entry.name === 'peer-session').length, 1);
  } finally {
    await cli?.stop().catch(() => undefined);
    await desktop.close().catch(() => undefined);
    if (previousHome === undefined) delete process.env.BRAINROUTER_HOME;
    else process.env.BRAINROUTER_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
