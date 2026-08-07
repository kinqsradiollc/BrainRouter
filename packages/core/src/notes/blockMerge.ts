/**
 * ADR-029 B1 + ADR-028 D4 — resolution, per block.
 *
 * D4's rules are unchanged and shared (`sync/stamped.ts`); what this file
 * decides is which of a block's fields get which rule, and that mapping is the
 * whole of B1's claim that the merge granularity is the block:
 *
 *  - `text` is free text, so concurrent edits keep BOTH with a marker. B2's
 *    lease exists to make that rare in a paragraph; it stays the floor for the
 *    case a lease cannot cover, which is both devices offline.
 *  - `parentId`, `rank`, `kind` and `level` are last-writer-wins. A block moved
 *    on two devices ends up in one place, and neither placement is a sentence
 *    someone loses.
 *  - `checked` ties toward done, for the reason `mergeCompletion` gives.
 *  - `language`, `icon`, `cover`, `collapsed` and `favourite` are
 *    last-writer-wins, for the same reason placement is: none of them is a
 *    sentence, and a conflict banner over a folded toggle teaches people to
 *    dismiss the banner that matters.
 *  - deletion resolves through the shared tombstone rule, so a block deleted on
 *    one device and typed into on another comes back marked rather than
 *    silently winning either way — EXCEPT when an explicit restore is newer
 *    than the tombstone, which is the one case where a person already decided.
 */
import { hlcAfter, type Hlc } from '../sync/hybridClock.js';
import {
  latestStamp, mergeCompletion, mergeField, mergeText, resolveTombstone,
  type ConflictReason, type ConflictRecord, type Stamped,
} from '../sync/stamped.js';
import type { NoteBlock } from './block.js';

/**
 * The three refusals `fenceBlockWrite` can return for an edit that has already
 * been typed — the ones that cost a write its owner's privileges.
 */
export type BlockFence = 'stale_epoch' | 'lease_expired' | 'blocked';

const FENCED_REASON: Record<BlockFence, ConflictReason> = {
  stale_epoch: 'fenced_stale_epoch',
  lease_expired: 'fenced_lease_expired',
  blocked: 'fenced_blocked',
};

/**
 * Merge two versions of one block.
 *
 * Every block is owned — there is no mirrored kind here, because a note block
 * projecting something whose truth lives elsewhere is an EMBED, and an embed
 * stores the reference rather than a copy of the target (A3). So D1's
 * owned/mirrored split has nothing to decide for notes, and this is always a
 * real merge.
 *
 * **`fenced` is what the lease epoch actually buys (B2/Q1).** It says `theirs`
 * did not hold the block when it was written, and it changes exactly one field:
 * `theirs` cannot take the TEXT, and if it would have — a stale device flushing
 * an edit authored later on its own clock — both are kept and marked instead.
 * A stamp arriving later is not evidence of having read what came before, and
 * last-writer-wins believes it is; that gap is the whole of migration 048's
 * defect, and the epoch is the only thing that closes it.
 *
 * Placement (`parentId`, `rank`), `kind`, `level` and `checked` stay
 * last-writer-wins even when fenced, deliberately: a lost placement is not a
 * lost sentence. Someone whose block moved drags it back in one gesture and can
 * see that it moved; someone whose paragraph was overwritten has no gesture and
 * no notice. Marking those too would put a conflict banner on a page for a
 * checkbox, which is how people learn to dismiss the banner that matters.
 */
export function mergeNoteBlock(ours: NoteBlock, theirs: NoteBlock, fenced?: BlockFence): NoteBlock {
  const conflicts: Record<string, ConflictRecord> = {
    ...(ours.conflicts ?? {}), ...(theirs.conflicts ?? {}),
  };

  const merged = mergeText(ours.text, theirs.text);
  const text = fenced ? fenceText(ours.text, theirs.text, merged, FENCED_REASON[fenced]) : merged;
  if (text.conflict) conflicts.text = text.conflict;

  const parentId = mergeField(ours.parentId, theirs.parentId)!;
  const rank = mergeField(ours.rank, theirs.rank)!;
  const kind = mergeField(ours.kind, theirs.kind)!;
  const level = mergeField(ours.level, theirs.level);
  const language = mergeField(ours.language, theirs.language);
  const icon = mergeField(ours.icon, theirs.icon);
  const cover = mergeField(ours.cover, theirs.cover);
  const collapsed = mergeField(ours.collapsed, theirs.collapsed);
  const favourite = mergeField(ours.favourite, theirs.favourite);
  const checked = mergeCompletion(ours.checked, theirs.checked);

  const newestEdit = latestStamp([
    latestBlockEdit({ ...ours, text: text.value! }),
    latestBlockEdit(theirs),
  ]);

  // A restore is not an edit and is compared only against the tombstone it was
  // aimed at. Routing it through `resolveTombstone`'s edit path would report
  // every deliberate restore as a `delete_vs_edit` conflict — asking a person
  // to decide something they just decided.
  const restoredAt = latestStamp([ours.restoredAt, theirs.restoredAt]);
  const deleteStamp = latestStamp([ours.deletedAt, theirs.deletedAt]);
  const undeleted = !!deleteStamp && !!restoredAt && hlcAfter(restoredAt, deleteStamp);

  const tombstone = undeleted
    // The tombstone is KEPT, outvoted rather than erased: liveness stays a
    // comparison both devices can make from the record alone, so a peer that
    // still holds only the delete converges instead of re-deleting.
    ? { deletedAt: deleteStamp }
    : resolveTombstone(ours.deletedAt, theirs.deletedAt, newestEdit);
  if (tombstone.conflict) conflicts.deleted = tombstone.conflict;

  return {
    id: ours.id,
    parentId,
    rank,
    kind,
    text: text.value!,
    ...(level ? { level } : {}),
    ...(language ? { language } : {}),
    ...(icon ? { icon } : {}),
    ...(cover ? { cover } : {}),
    ...(collapsed ? { collapsed } : {}),
    ...(favourite ? { favourite } : {}),
    ...(checked ? { checked } : {}),
    ...(tombstone.deletedAt ? { deletedAt: tombstone.deletedAt } : {}),
    ...(restoredAt ? { restoredAt } : {}),
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  };
}

/**
 * The fencing penalty, applied to text and to nothing else.
 *
 * The rule is narrow on purpose: a fenced write LOSES the field it would have
 * won, and is kept beside the winner rather than dropped. It is not punished
 * for losing on merit — a fenced edit with an older stamp was already going to
 * lose, and manufacturing a conflict for it would mark blocks where the outcome
 * was never in doubt.
 *
 * So a correct epoch buys nothing except the absence of this. It never buys the
 * right to overwrite text the writer had not seen, which is the inversion
 * ADR-028 D11 refuses: a client that is behind must not win by pushing last,
 * and holding the lock does not make it less behind.
 */
function fenceText(
  ours: Stamped<string> | undefined,
  theirs: Stamped<string> | undefined,
  merged: { value: Stamped<string> | undefined; conflict?: ConflictRecord },
  reason: ConflictReason,
): { value: Stamped<string> | undefined; conflict?: ConflictRecord } {
  // `mergeText` returns one of the two arguments, never a new object, so this
  // asks "did the fenced side take the field" without re-deriving the ordering.
  if (!ours || !theirs || merged.value !== theirs || ours.value === theirs.value) return merged;
  return {
    value: ours,
    conflict: {
      ours: ours.value, theirs: theirs.value,
      oursAt: ours.at, theirsAt: theirs.at,
      reason,
    },
  };
}

/**
 * The newest stamp among the fields that count as WORK on the block.
 *
 * `collapsed` and `favourite` are excluded deliberately. This value is what
 * decides whether an edit outranks a tombstone, and folding a toggle or pinning
 * something to the sidebar is not a reason to resurrect a block someone deleted
 * on another device — it is a view preference that happened to be synced.
 */
function latestBlockEdit(block: NoteBlock): Hlc | undefined {
  return latestStamp([
    block.text?.at, block.parentId?.at, block.rank?.at,
    block.kind?.at, block.level?.at, block.checked?.at,
    block.language?.at, block.icon?.at, block.cover?.at,
  ]);
}

/** Blocks a person still has to decide about. */
export function conflictedBlocks(blocks: Iterable<NoteBlock>): NoteBlock[] {
  return [...blocks].filter((b) => b.conflicts && Object.keys(b.conflicts).length > 0);
}

/**
 * The line shown where a conflicted block is rendered.
 *
 * D4 keeps both versions; this says so at the point of reading rather than in a
 * panel somewhere else. A conflict nobody is shown is the same as having
 * discarded the losing edit, which is the outcome D4 refuses.
 */
export function describeBlockConflict(block: NoteBlock): string | null {
  const fields = Object.keys(block.conflicts ?? {});
  if (fields.length === 0) return null;
  if (fields.includes('deleted')) {
    return 'This block was deleted on one device and edited on another — it is back, undecided.';
  }
  if (fields.includes('text')) {
    return describeConflictReason(block.conflicts!.text!.reason);
  }
  return `Changed in two places: ${fields.join(', ')}.`;
}

/**
 * One sentence per cause, because the causes are not the same event.
 *
 * "Two people typed at once" asks a person to pick. "Your device wrote under a
 * lock it no longer held" tells them why their sentence is not the one on
 * screen — without which the app looks like it lost their typing.
 */
export function describeConflictReason(reason: ConflictReason): string {
  switch (reason) {
    case 'fenced_stale_epoch':
      return 'This was typed under a lock that had already been reissued. Both versions are kept — pick one.';
    case 'fenced_lease_expired':
      return 'This was typed after the lock on the block had expired. Both versions are kept — pick one.';
    case 'fenced_blocked':
      return 'Another device was editing this block when this arrived. Both versions are kept — pick one.';
    case 'delete_vs_edit':
      return 'This block was deleted on one device and edited on another — it is back, undecided.';
    case 'concurrent_text':
      return 'This block was written in two places at once. Both versions are kept — pick one.';
  }
}

/**
 * Keep one side of a conflicted field.
 *
 * Applies the choice as a NEW stamped edit rather than restoring the old stamp,
 * so the resolution is itself an event that other devices merge normally. A
 * resolution written back under the losing side's original stamp would be
 * re-decided by the next sync, and the person would watch their choice undo
 * itself.
 */
export function resolveBlockConflict(
  block: NoteBlock,
  field: string,
  keep: 'ours' | 'theirs',
  at: Hlc,
): NoteBlock | null {
  const conflict = block.conflicts?.[field];
  if (!conflict) return null;

  const rest = { ...block.conflicts };
  delete rest[field];
  const chosen = keep === 'ours' ? conflict.ours : conflict.theirs;

  const next: NoteBlock = { ...block };
  if (field === 'text') next.text = { value: String(chosen), at };
  if (field === 'deleted') {
    // Keeping the edit is a RESTORE, recorded as one. Deleting the tombstone
    // instead would lose the comparison a peer still holding the delete needs,
    // and its next push would re-delete the block the person just kept.
    if (keep === 'ours') next.deletedAt = at;
    else next.restoredAt = at;
  }

  if (Object.keys(rest).length > 0) next.conflicts = rest;
  else delete next.conflicts;
  return next;
}

/** Did `candidate` supersede `existing`? Used to order a block's own history. */
export function blockEditIsNewer(candidate: NoteBlock, existing: NoteBlock): boolean {
  const a = latestBlockEdit(candidate);
  const b = latestBlockEdit(existing);
  if (!a) return false;
  if (!b) return true;
  return hlcAfter(a, b);
}
