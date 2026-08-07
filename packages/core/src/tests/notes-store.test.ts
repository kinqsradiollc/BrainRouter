/**
 * ADR-029 Part B — the store, which is the caller everything else in Notes
 * needs in order to be more than a set of libraries.
 *
 * The properties worth pinning here are the ones that only appear once the
 * pieces are wired together: a mutation stamps the clock AND queues one
 * operation per block (B3), a delete takes its subtree so a page's contents do
 * not scatter, and — the headline — a device that slept holding a lock cannot
 * land its stale write on top of the edit made while it was gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginEditing, createBlock, createPage, deleteBlock, endEditing, getBlock,
  keepEditing, listBlocks, listConflicts, moveBlock, noteTree, readNotes,
  resolveConflict, updateBlock, writeNotes,
} from '../notes/noteStore.js';
import { BLOCK_LEASE_MS, fenceBlockWrite } from '../notes/blockLease.js';

const T = Date.parse('2026-08-07T09:00:00.000Z');

/**
 * An isolated notes home per test.
 *
 * Notes are USER-scoped (D1), so the store writes under the brainrouter home
 * rather than a workspace — which means a test that does not redirect the home
 * writes into the developer's real notes.
 */
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-notes-'));
  process.env.BRAINROUTER_HOME = dir;
  return dir;
}
function cleanup(dir: string): void {
  delete process.env.BRAINROUTER_HOME;
  rmSync(dir, { recursive: true, force: true });
}

test('a created block persists and is readable back', () => {
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'the first line' }, T);
    assert.equal(getBlock(undefined, created.id)?.text.value, 'the first line');
    assert.equal(listBlocks(undefined).length, 1);
  } finally { cleanup(dir); }
});

test('a block id carries the device that minted it, so two devices cannot mint the same one', () => {
  // The planner's ids are time plus a module counter that restarts at zero with
  // the process, which is survivable when items are created rarely. A block is
  // created every time someone presses Enter, and the server key is
  // (org_id, user_id, id) — a collision does not coexist, it merges, and a
  // paragraph disappears.
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const state = readNotes(undefined);
    assert.ok(created.id.endsWith(`_${state.deviceId}`), `${created.id} must carry ${state.deviceId}`);
  } finally { cleanup(dir); }
});

test('B3 — every mutation stamps the clock and queues exactly one operation PER BLOCK', () => {
  // The outbox record is the block, so two blocks sync in parallel while edits
  // to one stay ordered. A page-level operation would serialise the whole
  // document behind whichever block was touched first.
  const dir = home();
  try {
    const one = createBlock(undefined, { text: 'one' }, T);
    const two = createBlock(undefined, { text: 'two' }, T + 1);
    updateBlock(undefined, one.id, { text: 'one, edited' }, T + 2);

    const state = readNotes(undefined);
    assert.equal(state.outbox.operations.length, 3);
    assert.deepEqual(
      state.outbox.operations.map((op) => op.itemId),
      [one.id, two.id, one.id],
    );
    assert.ok(state.clock.physical >= T + 2);
  } finally { cleanup(dir); }
});

test('a new block lands after its siblings without renumbering any of them', () => {
  const dir = home();
  try {
    const first = createBlock(undefined, { text: 'first' }, T);
    const second = createBlock(undefined, { text: 'second' }, T + 1);
    const firstRankBefore = getBlock(undefined, first.id)!.rank.value;

    const middle = createBlock(undefined, { text: 'middle', after: first.id }, T + 2);

    assert.equal(getBlock(undefined, first.id)!.rank.value, firstRankBefore, 'siblings must not be rewritten');
    const ranks = [first, middle, second].map((b) => getBlock(undefined, b.id)!.rank.value);
    assert.deepEqual([...ranks].sort(), ranks);
  } finally { cleanup(dir); }
});

test('B4 — a page is created through the same call as any other block', () => {
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Release notes' }, T);
    createBlock(undefined, { text: 'a line', parentId: page.id }, T + 1);

    const tree = noteTree(undefined);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0]!.block.kind.value, 'page');
    assert.equal(tree.roots[0]!.children.length, 1);
  } finally { cleanup(dir); }
});

test('deleting a page tombstones its subtree, so its contents do not scatter to the top level', () => {
  // A child left live under a deleted parent is neither deleted nor reachable.
  // The tree builder would surface it as an orphan at the top, which turns
  // deleting one page into scattering its paragraphs across the sidebar.
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Scratch' }, T);
    const child = createBlock(undefined, { text: 'a line', parentId: page.id }, T + 1);

    const removed = deleteBlock(undefined, page.id, T + 2);
    assert.deepEqual(removed, [page.id, child.id]);
    assert.ok(getBlock(undefined, child.id)?.deletedAt, 'the child must be tombstoned, not orphaned');
    assert.equal(noteTree(undefined).roots.length, 0);
  } finally { cleanup(dir); }
});

test('a delete leaves a tombstone rather than removing the record, so a later edit can resurrect it', () => {
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'draft' }, T);
    deleteBlock(undefined, created.id, T + 1);

    assert.ok(readNotes(undefined).blocks[created.id], 'the record must survive the delete');
    assert.equal(listBlocks(undefined).length, 0);
  } finally { cleanup(dir); }
});

test('a block cannot be moved inside its own subtree', () => {
  // Repairable later by the tree builder, but a cycle one device could see
  // coming is different: the block would vanish from where it was dropped and
  // reappear at the top with a repair notice, for an action that was never
  // possible.
  const dir = home();
  try {
    const page = createPage(undefined, { title: 'Parent' }, T);
    const child = createBlock(undefined, { text: 'child', parentId: page.id }, T + 1);

    const outcome = moveBlock(undefined, page.id, { parentId: child.id }, T + 2);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'would_nest_inside_itself');
  } finally { cleanup(dir); }
});

/* ------------------------------------------------------- B2 · the lease */

test('taking the lock lets this device write as the owner', () => {
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const lease = beginEditing(undefined, created.id, T);
    assert.ok(lease.ok);

    const write = updateBlock(undefined, created.id, { text: 'a, edited' }, T + 1000);
    assert.ok(write.ok);
    assert.equal(write.ok && write.path, 'leased');
  } finally { cleanup(dir); }
});

test('a queued edit carries the epoch it was AUTHORED under, not the epoch at flush time', () => {
  // The distinction is the whole point. Stamping at flush would re-fence a
  // stale edit as fresh, which is migration 048's defect one layer up — a
  // sleeping device waking and landing on top of what happened while it was
  // gone.
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const lease = beginEditing(undefined, created.id, T);
    assert.ok(lease.ok);
    updateBlock(undefined, created.id, { text: 'authored under epoch 1' }, T + 1000);

    // The lock is reissued while the operation is still queued.
    endEditing(undefined, created.id, { deviceId: readNotes(undefined).deviceId, epoch: lease.lease.epoch }, T + 2000);
    const reissued = beginEditing(undefined, created.id, T + 3000);
    assert.ok(reissued.ok);
    assert.equal(reissued.lease.epoch, lease.lease.epoch + 1);

    const queued = readNotes(undefined).outbox.operations.find((op) => op.kind === 'update');
    assert.ok(queued);
    assert.equal(
      (queued!.payload as { leaseEpoch?: number }).leaseEpoch,
      lease.lease.epoch,
      'the queued write must still name the epoch it was made under',
    );
  } finally { cleanup(dir); }
});

test('a write made after the lease expired is demoted to a merge instead of writing as the owner', () => {
  // B2's fallback: the edit is not lost — it goes through D4, which is the
  // floor — but it does not get to claim exclusivity it no longer has.
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    assert.ok(beginEditing(undefined, created.id, T).ok);

    const write = updateBlock(undefined, created.id, { text: 'typed after waking' }, T + BLOCK_LEASE_MS + 1);
    assert.ok(write.ok);
    assert.equal(write.ok && write.path, 'merge', 'an expired lock must not write as the owner');
    assert.equal(getBlock(undefined, created.id)?.text.value, 'typed after waking', 'and the edit must survive');
  } finally { cleanup(dir); }
});

test('a write made under a LAPSED lease still names the epoch it was made under', () => {
  // Sending the epoch only on the owner's path is the same leak inverted. No
  // epoch means "not claiming ownership" — a fresh edit on a block nothing
  // holds — so a device whose lease expired would arrive looking exactly like
  // one that never held the block, and the single write that most needs fencing
  // would be the one write the server cannot fence.
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const lease = beginEditing(undefined, created.id, T);
    assert.ok(lease.ok);

    updateBlock(undefined, created.id, { text: 'typed after waking' }, T + BLOCK_LEASE_MS + 1);

    const queued = readNotes(undefined).outbox.operations.filter((op) => op.kind === 'update').at(-1);
    assert.ok(queued);
    assert.equal(
      (queued!.payload as { leaseEpoch?: number }).leaseEpoch,
      lease.lease.epoch,
      'the server can only tell staleness from "never claimed it" if the epoch travels',
    );
  } finally { cleanup(dir); }
});

test('the fence reads the EPOCH, not just the device: a reissued lock refuses its own holder', () => {
  // The one comparison migration 048 exists for, isolated. Same device, live
  // lease, right block — only the token is old, which is exactly the state of a
  // write that was queued before the holder slept and re-acquired. Delete the
  // epoch clause and this write is waved through as the owner's.
  const lease = { blockId: 'blk_1', deviceId: 'd-laptop', epoch: 3, expiresAt: T + BLOCK_LEASE_MS };

  const stale = fenceBlockWrite(lease, { deviceId: 'd-laptop', epoch: 1 }, T);
  assert.equal(stale.path, 'merge');
  assert.equal(stale.path === 'merge' && stale.reason, 'stale_epoch');

  const current = fenceBlockWrite(lease, { deviceId: 'd-laptop', epoch: 3 }, T);
  assert.equal(current.path, 'leased', 'and the current epoch must still be the owner’s');
});

test('no epoch gets an OWNER’s write past a live holder — not even the holder’s own number', () => {
  // The epoch is tied to a peer, not just to a number, so quoting the current
  // one does not make another device the owner. Only the writer that took the
  // lease writes as its owner; everything else is fenced, and a claimless writer
  // is refused outright because nothing has been typed yet.
  const lease = { blockId: 'blk_1', deviceId: 'd-phone', epoch: 2, expiresAt: T + BLOCK_LEASE_MS };

  assert.equal(fenceBlockWrite(lease, { deviceId: 'd-laptop' }, T).path, 'blocked');
  for (const epoch of [1, 2, 99]) {
    const path = fenceBlockWrite(lease, { deviceId: 'd-laptop', epoch }, T);
    assert.notEqual(path.path, 'leased', `epoch ${epoch} must not write as the owner`);
    assert.equal(path.path === 'merge' && path.reason, 'stale_epoch');
  }
});

test('a block another device holds is refused with the holder named, not silently overwritten', () => {
  // B2's read-only-with-attribution. The state is written directly here because
  // the second device's lease arrives over the wire, not from this process.
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const state = readNotes(undefined);
    state.leases[created.id] = {
      blockId: created.id, deviceId: 'd-phone', holder: 'Anh’s phone', epoch: 4,
      expiresAt: T + BLOCK_LEASE_MS,
    };
    writeNotes(undefined, state);

    const write = updateBlock(undefined, created.id, { text: 'from the laptop' }, T + 1000);
    assert.equal(write.ok, false);
    assert.equal(write.ok === false && write.reason === 'locked' && write.holder.deviceId, 'd-phone');
    assert.equal(getBlock(undefined, created.id)?.text.value, 'a', 'the blocked write must change nothing');
  } finally { cleanup(dir); }
});

test('renewing while typing extends the lock without reissuing it', () => {
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'a' }, T);
    const lease = beginEditing(undefined, created.id, T);
    assert.ok(lease.ok);

    const claim = { deviceId: lease.lease.deviceId, epoch: lease.lease.epoch };
    const renewed = keepEditing(undefined, created.id, claim, T + 10_000);
    assert.ok(renewed.ok);
    assert.equal(renewed.lease.epoch, lease.lease.epoch);

    const write = updateBlock(undefined, created.id, { text: 'still typing' }, T + 20_000);
    assert.equal(write.ok && write.path, 'leased', 'a renewed lock must still be the owner’s');
  } finally { cleanup(dir); }
});

/* -------------------------------------------------------- D4 · conflicts */

test('a conflict is readable as its own list, because one nobody is shown is one that was discarded', () => {
  const dir = home();
  try {
    const created = createBlock(undefined, { text: 'ours' }, T);
    const state = readNotes(undefined);
    state.blocks[created.id] = {
      ...state.blocks[created.id]!,
      conflicts: {
        text: {
          ours: 'ours', theirs: 'theirs',
          oursAt: state.clock, theirsAt: { ...state.clock, deviceId: 'd-other' },
          reason: 'concurrent_text',
        },
      },
    };
    writeNotes(undefined, state);

    assert.equal(listConflicts(undefined).length, 1);

    const resolved = resolveConflict(undefined, created.id, 'text', 'theirs', T + 5000);
    assert.equal(resolved?.text.value, 'theirs');
    assert.equal(listConflicts(undefined).length, 0);
    assert.equal(
      readNotes(undefined).outbox.operations.some((op) => op.idempotencyKey.includes(':resolve:')),
      true,
      'the resolution must be queued, or the other device never learns of it',
    );
  } finally { cleanup(dir); }
});

test('a notes file from an older schema reads as empty rather than throwing', () => {
  // A surface that will not open because its cache is a shape it did not expect
  // is worse than one that starts blank and re-syncs.
  const dir = home();
  try {
    writeNotes(undefined, { schemaVersion: 1 } as never);
    const state = readNotes(undefined);
    assert.deepEqual(state.blocks, {});
    assert.deepEqual(state.leases, {});
    assert.equal(state.outbox.operations.length, 0);
  } finally { cleanup(dir); }
});
