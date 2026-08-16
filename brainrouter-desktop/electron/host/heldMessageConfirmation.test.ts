/**
 * ADR-034 production held-confirmation adapter regressions. They exercise the
 * real InteractionBroker round trip, pin tri-state resolution, and prove modal
 * cleanup occurs for the same request after either modal or Peers-panel input.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionBroker, type InteractionRequest } from '@kinqs/brainrouter-agent-protocol';
import type { HeldSessionMessageRecord } from '@kinqs/brainrouter-core/session';
import { requestDesktopHeldConfirmation } from './heldMessageConfirmation.js';

function record(): HeldSessionMessageRecord {
  const now = Date.now();
  return {
    id: 'held-broker-1',
    senderSessionKey: 'cli:sender',
    senderDeviceId: '11111111-1111-4111-8111-111111111111',
    targetSessionKey: 'desktop:recipient',
    text: 'Review this peer evidence.',
    source: 'peer-session',
    trust: 'untrusted-session',
    createdAt: now - 1,
    receivedAt: now,
    status: 'held',
    expiresAt: now + 60_000,
    holdReason: 'Needs human approval.',
    senderDetails: { transport: 'remote', clientKind: 'cli', title: 'Sender title' },
  };
}

test('production held adapter resolves an explicit Peers-panel decline and clears the modal', async () => {
  const broker = new InteractionBroker();
  const requests: Array<{ sessionKey: string; request: InteractionRequest }> = [];
  const resolved: Array<{ sessionKey: string; interactionId: string }> = [];
  const confirmation = requestDesktopHeldConfirmation(broker, record(), {
    emitRequest: (sessionKey, event) => requests.push({ sessionKey, request: event.request }),
    emitResolved: (sessionKey, interactionId) => resolved.push({ sessionKey, interactionId }),
  }, 1_000);

  assert.equal(broker.pendingCount, 1);
  assert.equal(requests[0]?.sessionKey, 'desktop:recipient');
  assert.equal(requests[0]?.request.type, 'confirm');
  assert.match(requests[0]?.request.type === 'confirm' ? requests[0].request.detail ?? '' : '', /Sender title/);
  assert.equal(confirmation.resolve(false), true);
  assert.equal(await confirmation.response, false);
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(resolved, [{
    sessionKey: 'desktop:recipient',
    interactionId: confirmation.interactionId,
  }]);
});

test('production held adapter maps broker dismissal to non-terminal null and still clears the modal', async () => {
  const broker = new InteractionBroker();
  const resolved: string[] = [];
  const confirmation = requestDesktopHeldConfirmation(broker, record(), {
    emitRequest: () => undefined,
    emitResolved: (_sessionKey, interactionId) => resolved.push(interactionId),
  }, 1_000);

  assert.equal(broker.resolve(confirmation.interactionId, { type: 'dismissed' }), true);
  assert.equal(await confirmation.response, null);
  assert.deepEqual(resolved, [confirmation.interactionId]);
});

test('production held adapter strips ANSI, OSC, and C0 controls from modal fields', async () => {
  const broker = new InteractionBroker();
  const hostile = '\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b]8;;https://invalid.example\u0007link\u001b]8;;\u0007\u001b[31m';
  const unsafe = record();
  unsafe.senderSessionKey = `cli:${hostile}\u0000sender`;
  unsafe.text = `first line\nsecond line ${hostile}`;
  unsafe.senderDetails = {
    transport: 'remote',
    clientKind: 'cli',
    title: `title ${hostile}`,
    workspaceRoot: `/repo/${hostile}`,
  };
  let request: InteractionRequest | undefined;
  const confirmation = requestDesktopHeldConfirmation(broker, unsafe, {
    emitRequest: (_sessionKey, event) => { request = event.request; },
    emitResolved: () => undefined,
  }, 1_000);

  assert.equal(request?.type, 'confirm');
  const presented = request?.type === 'confirm'
    ? `${request.title}\n${request.detail ?? ''}`
    : '';
  assert.match(presented, /first line\nsecond line/);
  assert.match(presented, /link/);
  assert.doesNotMatch(presented, /\u001b|\u0007|\u0000/);
  assert.doesNotMatch(presented, /Y2xpcGJvYXJk|https:\/\/invalid\.example/);
  broker.resolve(confirmation.interactionId, { type: 'dismissed' });
  assert.equal(await confirmation.response, null);
});
