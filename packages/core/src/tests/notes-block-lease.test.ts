/**
 * ADR-029 B2 / Q1 — the block lock, and the reason it is a lease with a fencing
 * epoch rather than a flag.
 *
 * Migration 048 exists because we shipped a lease without a fence once: a
 * worker held it, a sweeper released it, a second worker claimed the job, and
 * the first wrote its stale result over the new run. Every test below is one
 * step of that sequence, moved up a layer to a paragraph somebody was typing.
 *
 * The one that matters most is `a device that slept…`: it is the whole defect,
 * end to end, and it is written so that removing the epoch check makes it fail
 * rather than making it pass differently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireBlockLease, describeBlockLease, fenceBlockWrite, isLeaseLive,
  releaseBlockLease, renewBlockLease, sweepBlockLeases,
  BLOCK_LEASE_MS, type BlockLease,
} from '../notes/blockLease.js';

const T = Date.parse('2026-08-07T10:00:00.000Z');
const PHONE = 'd-phone';
const LAPTOP = 'd-laptop';

function take(current: BlockLease | undefined, deviceId: string, at: number, holder?: string): BlockLease {
  const outcome = acquireBlockLease(current, { blockId: 'blk_1', deviceId, ...(holder ? { holder } : {}) }, at);
  assert.ok(outcome.ok, 'expected the lease to be granted');
  return outcome.lease;
}

test('taking a lease issues a NEW epoch, so anyone holding the old one is fenced from that moment', () => {
  // 048's claim does exactly this, and its comment says why: without a fresh
  // token, reclaiming an expired lease hands the block to two writers at once.
  const first = take(undefined, PHONE, T);
  assert.equal(first.epoch, 1);

  const reclaimed = take(first, LAPTOP, T + BLOCK_LEASE_MS + 1);
  assert.equal(reclaimed.epoch, 2, 'the reclaim must not reuse the previous epoch');
});

test('a device that slept holding the lock cannot overwrite the edit made while it was gone', () => {
  // This is migration 048's defect, one layer up. The phone takes the lock,
  // sleeps, the lease lapses, the laptop takes over and types. The phone wakes
  // and flushes the sentence it queued before sleeping.
  const phoneLease = take(undefined, PHONE, T);
  const phoneClaim = { deviceId: PHONE, epoch: phoneLease.epoch };

  const laptopLease = take(phoneLease, LAPTOP, T + BLOCK_LEASE_MS + 1);

  const wokenWrite = fenceBlockWrite(laptopLease, phoneClaim, T + BLOCK_LEASE_MS + 2);
  assert.notEqual(wokenWrite.path, 'leased', 'the stale holder must not write as the owner');
  assert.equal(wokenWrite.path, 'merge');
  assert.equal(wokenWrite.path === 'merge' && wokenWrite.reason, 'stale_epoch');

  // And the rightful holder is unaffected — a fence that also blocks the
  // current owner is a deadlock, not a lock.
  const owner = fenceBlockWrite(laptopLease, { deviceId: LAPTOP, epoch: laptopLease.epoch }, T + BLOCK_LEASE_MS + 2);
  assert.equal(owner.path, 'leased');
});

test('the SAME device re-acquiring fences its own earlier claim', () => {
  // The case that makes the epoch load-bearing rather than decorative. Every
  // other stale-write scenario in this file is also caught by the device id, so
  // a fence built on the device alone would pass them and fail here: an app
  // restarts, re-acquires the lock, and an operation authored before the
  // restart is still sitting in the outbox. Treating that as an owned write
  // lands it on top of whatever was typed after the restart.
  const before = take(undefined, PHONE, T);
  const afterRestart = take(before, PHONE, T + 1);
  assert.equal(afterRestart.epoch, before.epoch + 1);

  const stale = fenceBlockWrite(afterRestart, { deviceId: PHONE, epoch: before.epoch }, T + 2);
  assert.equal(stale.path, 'merge');
  assert.equal(stale.path === 'merge' && stale.reason, 'stale_epoch');
});

test('a fenced write MERGES rather than being discarded, because it is a sentence a person typed', () => {
  // The deliberate departure from 048, where a fenced write is dropped. Here
  // the losing device keeps its words; D4 decides what happens to them.
  const phoneLease = take(undefined, PHONE, T);
  const laptopLease = take(phoneLease, LAPTOP, T + BLOCK_LEASE_MS + 1);

  const fenced = fenceBlockWrite(laptopLease, { deviceId: PHONE, epoch: phoneLease.epoch }, T + BLOCK_LEASE_MS + 2);
  assert.equal(fenced.path, 'merge', 'a refused write must still reach the merge, not the bin');
});

test('an expired lease does not block anyone, so a device that never came back cannot freeze a block', () => {
  const stale = take(undefined, PHONE, T);
  assert.equal(isLeaseLive(stale, T + BLOCK_LEASE_MS + 1), false);

  const acquired = acquireBlockLease(stale, { blockId: 'blk_1', deviceId: LAPTOP }, T + BLOCK_LEASE_MS + 1);
  assert.ok(acquired.ok, 'an expired lease must not make a block permanently uneditable');
});

test('a live lease held elsewhere blocks a NEW edit and names who has it', () => {
  // B2's prevention half: read-only with an attribution, rather than a conflict
  // marker landing mid-paragraph while someone is reading.
  const lease = take(undefined, PHONE, T, 'Anh’s phone');

  const refused = acquireBlockLease(lease, { blockId: 'blk_1', deviceId: LAPTOP }, T + 1000);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, 'held_by_another');
  assert.match(refused.ok === false ? refused.detail : '', /Anh’s phone/);

  const start = fenceBlockWrite(lease, { deviceId: LAPTOP }, T + 1000);
  assert.equal(start.path, 'blocked');
});

test('renewing keeps the term but NOT the epoch, so the holder’s own queued writes stay valid', () => {
  // Bumping on renewal would fence the holder against itself: every edit it had
  // already queued would carry a token that no longer matches.
  const lease = take(undefined, PHONE, T);
  const renewed = renewBlockLease(lease, { deviceId: PHONE, epoch: lease.epoch }, T + 10_000);
  assert.ok(renewed.ok);
  assert.equal(renewed.lease.epoch, lease.epoch);
  assert.equal(renewed.lease.expiresAt, T + 10_000 + BLOCK_LEASE_MS);
});

test('an EXPIRED lease is not renewed even by its own holder with the right epoch', () => {
  // 048's live leak is an unfenced heartbeat that keeps a lease looking healthy
  // while the wrong process holds it. Renewing across an expiry would do the
  // same thing here: re-establish exclusivity over content this device has not
  // seen. Re-acquiring is correct, and re-acquiring bumps the epoch.
  const lease = take(undefined, PHONE, T);
  const outcome = renewBlockLease(lease, { deviceId: PHONE, epoch: lease.epoch }, T + BLOCK_LEASE_MS + 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'lease_expired');
});

test('a stale-epoch renewal is refused with a DIFFERENT reason from an expired one', () => {
  // 048 collapses "not running" and "wrong epoch" into a bare null. B2 needs an
  // attribution line, and "someone took the lock" and "your lock ran out" lead
  // the reader to different actions.
  const lease = take(undefined, PHONE, T);
  const reacquired = take(lease, PHONE, T + 1);
  const outcome = renewBlockLease(reacquired, { deviceId: PHONE, epoch: lease.epoch }, T + 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'stale_epoch');
});

test('releasing ends the term but keeps the epoch, so it cannot be reset back to a sleeping device’s claim', () => {
  // A fencing token that can be reset is not a fencing token: dropping the
  // record would make the next acquisition mint epoch 1 again, matching the
  // epoch a sleeping device is still carrying.
  const lease = take(undefined, PHONE, T);
  const released = releaseBlockLease(lease, { deviceId: PHONE, epoch: lease.epoch }, T + 5000);
  assert.ok(released.ok);
  assert.equal(released.lease.epoch, lease.epoch);
  assert.equal(isLeaseLive(released.lease, T + 5000), false);

  const next = take(released.lease, LAPTOP, T + 6000);
  assert.equal(next.epoch, 2, 'the epoch must keep climbing across a release');
});

test('releasing someone else’s lease is refused, so closing a stale tab cannot unlock a live edit', () => {
  const lease = take(undefined, PHONE, T);
  const outcome = releaseBlockLease(lease, { deviceId: LAPTOP, epoch: lease.epoch }, T + 1000);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'held_by_another');
});

test('a write with no claim is allowed when nothing holds the block — soft locking, not required locking', () => {
  // B2 chose SOFT locks. Requiring a lease to type would turn every offline
  // edit into a refusal, which is the opposite of D2's position on offline.
  const path = fenceBlockWrite(undefined, { deviceId: PHONE }, T);
  assert.equal(path.path, 'merge');
  assert.equal(path.path === 'merge' && path.reason, 'no_lease');
});

test('the attribution says nothing to the device already holding the lock', () => {
  const lease = take(undefined, PHONE, T, 'Anh’s phone');
  assert.equal(describeBlockLease(lease, PHONE, T + 1000), null);
  assert.equal(describeBlockLease(lease, LAPTOP, T + 1000), 'Being edited on Anh’s phone');
  assert.equal(describeBlockLease(lease, LAPTOP, T + BLOCK_LEASE_MS + 1), null, 'an expired lock attributes nothing');
});

test('sweeping keeps every lease that a still-flushable write could name', () => {
  // The retention is tied to the outbox's, and that link is the safety
  // argument: an operation older than the queue keeps has already been shed, so
  // no write carrying that epoch can exist any more.
  const recent = take(undefined, PHONE, T);
  const ancient: BlockLease = { blockId: 'blk_old', deviceId: PHONE, epoch: 9, expiresAt: T - 40 * 86_400_000 };

  const kept = sweepBlockLeases(
    { blk_1: recent, blk_old: ancient },
    T + 1000,
    30 * 86_400_000,
  );
  assert.deepEqual(Object.keys(kept), ['blk_1']);
});
