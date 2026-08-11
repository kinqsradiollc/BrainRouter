/**
 * ADR-034 Peers surface regression: discovery labels expose exact routing and
 * transport truth without upgrading persistence into application.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { PeersPanel, heldDecisionNotice, peerRouteLabel } from './PeersPanel.js';
import { mount, press, screenText, typeInto } from '../../testing/reactHarness.js';

interface QueryCommand {
  kind: 'query';
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

function installPeerBridge(
  t: TestContext,
  decisionTransport: 'local' | 'remote' = 'remote',
  unsafePeerFields = false,
): { commands: QueryCommand[] } {
  const original = globalThis.window;
  const commands: QueryCommand[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let held = true;
  const hostile = unsafePeerFields
    ? '\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b]0;forged title\u0007\u001b[31m\u0000'
    : '';
  const response = (name: string): unknown => {
    if (name === 'peers-list') return {
      ownSessionKey: `desktop:recipient${hostile}`, brainOnline: true,
      routes: unsafePeerFields ? [{
        sessionKey: `cli:route${hostile}`,
        deviceId: 'device-unsafe',
        clientKind: 'cli',
        state: 'idle',
        transport: 'remote',
        title: `Visible route${hostile}`,
      }] : [],
    };
    if (name === 'peers-held') return { messages: held ? [{
      id: 'held-ui-1', senderSessionKey: `cli:sender${hostile}`,
      senderDeviceId: '11111111-1111-4111-8111-111111111111',
      text: `Please apply this peer context.\nSecond line${hostile}`, status: 'held',
      holdReason: `Needs human approval.${hostile}`, createdAt: Date.now() - 10,
      expiresAt: Date.now() + 60_000, transport: 'remote', clientKind: 'cli',
    }] : [] };
    if (name === 'peers-receipts') return { receipts: [] };
    if (name === 'peers-held-decide') {
      held = false;
      return { id: 'held-ui-1', status: 'rejected', transport: decisionTransport };
    }
    if (name === 'peers-send') return {
      ok: true,
      status: 'pending',
      wording: 'Persisted for the recipient; not yet applied.',
      updatedAt: new Date().toISOString(),
    };
    return {};
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      brainrouter: {
        send: (command: QueryCommand) => {
          commands.push(command);
          queueMicrotask(() => {
            for (const listener of [...listeners]) {
              listener({
                kind: 'query-result',
                id: command.id,
                ok: true,
                result: response(command.name),
              });
            }
          });
        },
        onEvent: (listener: (message: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  t.after(() => {
    if (original === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
  });
  return { commands };
}

test('Peers renderer labels CLI/Desktop provenance and never treats titles as addresses', () => {
  const label = peerRouteLabel({
    sessionKey: 'cli:release-check',
    title: 'Release readiness',
    deviceId: 'device-1',
    clientKind: 'cli',
    state: 'working',
    transport: 'local',
  });
  assert.equal(label, 'Release readiness · cli · local');
  assert.doesNotMatch(label, /^cli:release-check/);
});

test('Peers renderer calls out duplicate exact keys as unavailable', () => {
  assert.match(peerRouteLabel({
    sessionKey: 'desktop:review',
    deviceId: 'device-2',
    clientKind: 'desktop',
    state: 'idle',
    transport: 'local',
    ambiguous: true,
    instanceCount: 2,
  }), /duplicate key/);
});

test('held-decision wording distinguishes remote receipt updates from local-only refusal', () => {
  assert.equal(heldDecisionNotice(false, 'remote'), 'Declined; the remote sender receipt was updated.');
  assert.equal(heldDecisionNotice(false, 'local'), 'Declined locally; this message will not be applied.');
  assert.equal(heldDecisionNotice(true, 'local'), 'Approved and queued for the Agent’s next safe boundary.');
});

test('rendered Decline control sends an explicit false decision through the query bridge', async (t) => {
  const bridge = installPeerBridge(t);
  const mounted = await mount(React.createElement(PeersPanel));
  t.after(() => mounted.unmount());

  assert.match(screenText(mounted.root), /Please apply this peer context/);
  await press(mounted, 'Decline');

  const decision = bridge.commands.find((command) => command.name === 'peers-held-decide');
  assert.deepEqual(decision?.args, { id: 'held-ui-1', approved: false });
  assert.match(screenText(mounted.root), /Declined; the remote sender receipt was updated/);
  assert.doesNotMatch(screenText(mounted.root), /Please apply this peer context/);
});

test('rendered local Decline never claims that a sender receipt was updated', async (t) => {
  installPeerBridge(t, 'local');
  const mounted = await mount(React.createElement(PeersPanel));
  t.after(() => mounted.unmount());

  await press(mounted, 'Decline');
  assert.match(screenText(mounted.root), /Declined locally; this message will not be applied/);
  assert.doesNotMatch(screenText(mounted.root), /receipt was updated/);
});

test('rendered Send composer forwards exact address/text and preserves pending-not-applied wording', async (t) => {
  const bridge = installPeerBridge(t);
  const mounted = await mount(React.createElement(PeersPanel));
  t.after(() => mounted.unmount());

  await typeInto(mounted, 'Select a participant or paste a key', 'cli:remote-target');
  await typeInto(mounted, 'Share evidence, context, or a handoff…', 'Review the release evidence.');
  await press(mounted, 'Send');

  const sent = bridge.commands.find((command) => command.name === 'peers-send');
  assert.deepEqual(sent?.args, {
    to: 'cli:remote-target',
    text: 'Review the release evidence.',
  });
  assert.match(screenText(mounted.root), /Persisted for the recipient; not yet applied/);
});

test('rendered peer fields strip ANSI, OSC, and C0 controls without losing ordinary text', async (t) => {
  installPeerBridge(t, 'remote', true);
  const mounted = await mount(React.createElement(PeersPanel));
  t.after(() => mounted.unmount());

  const out = screenText(mounted.root);
  assert.match(out, /Visible route/);
  assert.match(out, /Please apply this peer context\.\nSecond line/);
  assert.doesNotMatch(out, /\u001b|\u0007|\u0000/);
  assert.doesNotMatch(out, /Y2xpcGJvYXJk|forged title/);
});
