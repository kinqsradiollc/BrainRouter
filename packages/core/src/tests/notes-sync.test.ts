/**
 * ADR-029 B3 — offline is the same offline.
 *
 * B3 is a claim about the CODE, not only about behaviour: Notes must reuse the
 * planner's stack rather than grow a second one, because two sync systems in
 * one product disagree and the disagreement is indistinguishable from a bug in
 * whichever surface you happen to be looking at.
 *
 * So this file does two things. It re-runs D11's data-destroying cases against
 * the notes instantiation — a first sync must never delete, a rejected
 * operation must not be dropped, an offline push must not undo a completed
 * pull. And it asserts structurally that there is only one loop, because a
 * behavioural test cannot tell a shared implementation from a faithful copy,
 * and a faithful copy is exactly what drifts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRemoteBlock, describeNotesSync, syncNotesOnce,
  type NotesPullResponse, type NotesTransport, type PushResponse,
} from '../notes/notesSync.js';
import type { NotesState } from '../notes/noteStore.js';
import type { NoteBlock } from '../notes/block.js';
import { emptyOutbox, enqueue, type OutboxOperation } from '../sync/outbox.js';
import type { Hlc } from '../sync/hybridClock.js';

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const at = (physical: number, logical = 0, deviceId = 'da'): Hlc => ({ physical, logical, deviceId });
const s = <T>(value: T, stamp = at(100)) => ({ value, at: stamp });

function state(over: Partial<NotesState> = {}): NotesState {
  return {
    schemaVersion: 1,
    deviceId: 'da',
    clock: at(100),
    blocks: {},
    leases: {},
    outbox: emptyOutbox(),
    ...over,
  };
}

function block(id: string, text: string, stamp = at(100)): NoteBlock {
  return {
    id,
    parentId: s<string | null>(null, stamp),
    rank: s('U', stamp),
    kind: s('paragraph' as const, stamp),
    text: s(text, stamp),
  };
}

function transport(over: Partial<NotesTransport> = {}): NotesTransport {
  return {
    pull: async (): Promise<NotesPullResponse> => ({ items: [], cursor: 'c1' }),
    push: async (): Promise<PushResponse> => ({ accepted: [], rejected: [] }),
    ...over,
  };
}

/**
 * Stamped just before `NOW` on purpose: the sync sheds anything older than the
 * outbox retention before it does anything else, so an operation stamped at a
 * toy physical time is discarded and the test measures the shed rather than the
 * push it meant to.
 */
function op(id: string, key = `${id}:k`): OutboxOperation {
  return { idempotencyKey: key, itemId: id, kind: 'update', at: at(NOW - 1000), payload: {}, attempts: 0 };
}

test('B3 — notes owns no sync loop of its own; the pull-then-push cycle is the shared one', () => {
  // A behavioural test cannot distinguish a shared implementation from a
  // faithful copy, and a faithful copy is precisely what drifts. So this reads
  // the source: the notes module must delegate, not reimplement.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(here, '..', '..', 'src', 'notes', 'notesSync.ts'), 'utf8');

  assert.match(source, /from '\.\.\/sync\/recordSync\.js'/, 'notes must import the shared engine');
  for (const copied of ['transport.pull(', 'transport.push(', 'shed(']) {
    assert.equal(
      source.includes(copied),
      false,
      `notesSync re-implements \`${copied}\` — that is the second sync stack B3 forbids`,
    );
  }
});

test('a first sync accepts everything and deletes nothing, because an empty cache is a NEW DEVICE', () => {
  // The case that most often produces catastrophe: an empty local cache meeting
  // a populated server looks identical to "everything was deleted" if you diff
  // naively.
  const local = state();
  const result = applyRemoteBlock(local, block('blk_1', 'from the server'), '2026-08-07T12:00:00.000Z');

  assert.equal(result.conflicted, false);
  assert.equal(local.blocks.blk_1?.text.value, 'from the server');
});

test('a pulled block merges against the local copy rather than replacing it', () => {
  const local = state({ blocks: { blk_1: block('blk_1', 'typed here', at(300, 1, 'da')) } });
  applyRemoteBlock(local, block('blk_1', 'typed there', at(300, 1, 'db')), '2026-08-07T12:00:00.000Z');

  assert.ok(local.blocks.blk_1?.conflicts?.text, 'a concurrent edit must be preserved, not overwritten');
});

test('a conflicted pull is reported by block id, so a surface can point at the paragraph', () => {
  const local = state({ blocks: { blk_1: block('blk_1', 'ours', at(300, 1, 'da')) } });
  const result = applyRemoteBlock(local, block('blk_1', 'theirs', at(300, 1, 'db')), 'now');
  assert.equal(result.conflicted, true);
});

test('a failed push does not undo the pull that already succeeded', () => {
  const local = state({ outbox: enqueue(emptyOutbox(), op('blk_1')) });
  return syncNotesOnce(
    local,
    transport({
      pull: async () => ({ items: [block('blk_1', 'server copy')], cursor: 'c2' }),
      push: async () => { throw new Error('offline'); },
    }),
    NOW,
  ).then((result) => {
    assert.equal(result.pulled, 1);
    assert.equal(result.offline, true);
    assert.equal(local.lastPulledAt, 'c2', 'the cursor from a successful pull must be kept');
    assert.equal(local.outbox.operations.length, 1, 'the unsent operation must still be queued');
  });
});

test('a rejected operation stays in the outbox with its reason, rather than vanishing', () => {
  // Silently discarding an operation is work somebody did that nobody will ever
  // tell them was lost.
  const local = state({ outbox: enqueue(emptyOutbox(), op('blk_1', 'k1')) });
  return syncNotesOnce(
    local,
    transport({ push: async () => ({ accepted: [], rejected: [{ idempotencyKey: 'k1', reason: 'stale lease epoch' }] }) }),
    NOW,
  ).then((result) => {
    assert.deepEqual(result.rejected, [{ idempotencyKey: 'k1', reason: 'stale lease epoch' }]);
    assert.equal(local.outbox.operations[0]?.lastError, 'stale lease epoch');
    assert.equal(local.outbox.operations[0]?.attempts, 1);
  });
});

test('the device absorbs the server clock, so a slow device stops losing every tie', () => {
  const local = state({ clock: at(100) });
  return syncNotesOnce(
    local,
    transport({ pull: async () => ({ items: [], cursor: 'c1', serverClock: at(9_000, 0, 'server') }) }),
    NOW,
  ).then(() => {
    assert.ok(local.clock.physical >= 9_000);
    assert.equal(local.clock.deviceId, 'da', 'absorbing a peer’s clock does not change who we are');
  });
});

test('leases do not travel in the synced record, or the faster clock would win the lock', () => {
  // A lease merged by last-writer-wins would hand the lock to whichever device
  // has the faster clock regardless of who was refused it — the failure B2
  // exists to prevent, inverted. The lock's authority crosses the wire as the
  // epoch stamped on each write, not as the lease itself.
  const local = state({
    leases: {
      blk_1: { blockId: 'blk_1', deviceId: 'd-phone', epoch: 3, expiresAt: NOW + 30_000 },
    },
  });
  return syncNotesOnce(local, transport({ pull: async () => ({ items: [block('blk_1', 'remote')], cursor: 'c1' }) }), NOW)
    .then(() => {
      assert.deepEqual(
        local.leases.blk_1,
        { blockId: 'blk_1', deviceId: 'd-phone', epoch: 3, expiresAt: NOW + 30_000 },
        'a pull must not touch a lease',
      );
      assert.equal('lease' in (local.blocks.blk_1 as object), false, 'a block record carries no lease');
    });
});

test('the sync line names blocks, so the reader is told about the thing they are looking at', () => {
  const line = describeNotesSync(
    { pulled: 0, pushed: 0, rejected: [], conflicted: ['blk_1', 'blk_2'], offline: false },
    emptyOutbox(),
  );
  assert.match(line, /2 blocks changed in two places/);
});

test('offline is stated as pending work, never as a failure', () => {
  // D2's position: offline is the normal mode that happens to be syncing, and a
  // banner announcing degradation trains people to ignore the line.
  const line = describeNotesSync(
    { pulled: 0, pushed: 0, rejected: [], conflicted: [], offline: true },
    enqueue(emptyOutbox(), op('blk_1')),
  );
  assert.equal(line, '1 change waiting to sync.');
});
