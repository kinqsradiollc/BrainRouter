/**
 * ADR-028 B1 — receipts that do not overclaim.
 *
 * The two properties that matter:
 *
 *  - Nothing reaches `acknowledged` without evidence. Presence in the context
 *    window is `delivered`, and no amount of presence adds up to consumed.
 *  - A message still queued when the turn ends is DROPPED and loud. That is the
 *    most harmful case in the lifecycle, because the sender has every reason to
 *    believe it landed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  queueMessage,
  markDelivered,
  markAcknowledged,
  markDropped,
  describeReceipt,
  needsResendPrompt,
  reconcileQueueOnTurnEnd,
} from '../task/messageReceipts.js';

const T0 = '2026-08-04T10:00:00.000Z';
const T1 = '2026-08-04T10:00:05.000Z';

test('a new message is queued, and says so', () => {
  const r = queueMessage('m1', T0);
  assert.equal(r.state, 'queued');
  assert.match(describeReceipt(r), /Queued/);
});

test('delivery records the turn that carried it', () => {
  const r = markDelivered(queueMessage('m1', T0), 'turn-7', T1);
  assert.equal(r.state, 'delivered');
  assert.equal(r.turnId, 'turn-7');
  assert.equal(r.deliveredAt, T1);
});

test('the delivered label never says "read"', () => {
  // A read receipt is a claim about model attention, which is not observable
  // from outside. A false receipt is worse than none — it is exactly what
  // stops you repeating yourself.
  const text = describeReceipt(markDelivered(queueMessage('m1', T0), 't', T1));
  assert.doesNotMatch(text, /read/i);
  assert.doesNotMatch(text, /seen/i);
  assert.match(text, /context/);
});

test('acknowledgement carries the evidence that produced it', () => {
  const r = markAcknowledged(
    markDelivered(queueMessage('m1', T0), 't', T1),
    { kind: 'plan_revision', revision: 3 },
    T1,
  );
  assert.equal(r.state, 'acknowledged');
  assert.deepEqual(r.evidence, { kind: 'plan_revision', revision: 3 });
  assert.match(describeReceipt(r), /r3/);
});

test('each kind of evidence is described distinctly', () => {
  const base = markDelivered(queueMessage('m1', T0), 't', T1);
  assert.match(
    describeReceipt(markAcknowledged(base, { kind: 'explicit_ack', detail: 'x' }, T1)),
    /referred to it/,
  );
  assert.match(
    describeReceipt(markAcknowledged(base, { kind: 'steer_reconciled', receiptId: 'r1' }, T1)),
    /work contract/,
  );
});

test('an acknowledged message cannot be walked back to dropped', () => {
  // It was demonstrably consumed. Later queue bookkeeping does not undo that.
  const ack = markAcknowledged(
    markDelivered(queueMessage('m1', T0), 't', T1),
    { kind: 'explicit_ack', detail: 'x' },
    T1,
  );
  assert.equal(markDropped(ack, 'turn_ended', T1).state, 'acknowledged');
});

test('delivery does not re-fire on an already-delivered message', () => {
  const once = markDelivered(queueMessage('m1', T0), 'turn-1', T1);
  const twice = markDelivered(once, 'turn-2', '2026-08-04T11:00:00.000Z');
  assert.equal(twice.turnId, 'turn-1', 'the first delivery is the one that happened');
});

test('a message still queued when the turn ends is dropped, and says it was NOT seen', () => {
  // The whole reason B1 exists. Silently discarding this leaves the sender
  // believing it arrived, and the divergence surfaces much later as the agent
  // doing the thing they thought they had corrected.
  const { updated, needsAttention } = reconcileQueueOnTurnEnd(
    [queueMessage('m1', T0), markDelivered(queueMessage('m2', T0), 't', T1)],
    T1,
  );
  assert.equal(updated[0]!.state, 'dropped');
  assert.equal(updated[0]!.dropReason, 'turn_ended');
  assert.equal(updated[1]!.state, 'delivered', 'a delivered message is untouched');
  assert.equal(needsAttention.length, 1);
  assert.match(describeReceipt(updated[0]!), /not seen/i);
});

test('a drop the sender did not cause prompts a resend', () => {
  for (const reason of ['turn_ended', 'session_closed', 'error'] as const) {
    assert.equal(
      needsResendPrompt(markDropped(queueMessage('m', T0), reason, T1)),
      true,
      `${reason} must be surfaced`,
    );
  }
});

test('a drop the sender caused does not nag them', () => {
  // Telling someone about a message they themselves replaced is noise, and
  // noise is what makes the loud cases stop working.
  for (const reason of ['superseded', 'expired'] as const) {
    assert.equal(needsResendPrompt(markDropped(queueMessage('m', T0), reason, T1)), false);
  }
});

test('a non-dropped receipt never asks for a resend', () => {
  assert.equal(needsResendPrompt(queueMessage('m', T0)), false);
  assert.equal(needsResendPrompt(markDelivered(queueMessage('m', T0), 't', T1)), false);
});
