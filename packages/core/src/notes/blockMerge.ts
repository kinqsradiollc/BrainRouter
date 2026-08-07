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
 *  - deletion resolves through the shared tombstone rule, so a block deleted on
 *    one device and typed into on another comes back marked rather than
 *    silently winning either way.
 */
import { hlcAfter, type Hlc } from '../sync/hybridClock.js';
import {
  latestStamp, mergeCompletion, mergeField, mergeText, resolveTombstone,
  type ConflictRecord,
} from '../sync/stamped.js';
import type { NoteBlock } from './block.js';

/**
 * Merge two versions of one block.
 *
 * Every block is owned — there is no mirrored kind here, because a note block
 * projecting something whose truth lives elsewhere is an EMBED, and an embed
 * stores the reference rather than a copy of the target (A3). So D1's
 * owned/mirrored split has nothing to decide for notes, and this is always a
 * real merge.
 */
export function mergeNoteBlock(ours: NoteBlock, theirs: NoteBlock): NoteBlock {
  const conflicts: Record<string, ConflictRecord> = {
    ...(ours.conflicts ?? {}), ...(theirs.conflicts ?? {}),
  };

  const text = mergeText(ours.text, theirs.text);
  if (text.conflict) conflicts.text = text.conflict;

  const parentId = mergeField(ours.parentId, theirs.parentId)!;
  const rank = mergeField(ours.rank, theirs.rank)!;
  const kind = mergeField(ours.kind, theirs.kind)!;
  const level = mergeField(ours.level, theirs.level);
  const checked = mergeCompletion(ours.checked, theirs.checked);

  const newestEdit = latestStamp([
    latestBlockEdit({ ...ours, text: text.value! }),
    latestBlockEdit(theirs),
  ]);
  const tombstone = resolveTombstone(ours.deletedAt, theirs.deletedAt, newestEdit);
  if (tombstone.conflict) conflicts.deleted = tombstone.conflict;

  return {
    id: ours.id,
    parentId,
    rank,
    kind,
    text: text.value!,
    ...(level ? { level } : {}),
    ...(checked ? { checked } : {}),
    ...(tombstone.deletedAt ? { deletedAt: tombstone.deletedAt } : {}),
    ...(Object.keys(conflicts).length ? { conflicts } : {}),
  };
}

function latestBlockEdit(block: NoteBlock): Hlc | undefined {
  return latestStamp([
    block.text?.at, block.parentId?.at, block.rank?.at,
    block.kind?.at, block.level?.at, block.checked?.at,
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
    return 'This block was written in two places at once. Both versions are kept — pick one.';
  }
  return `Changed in two places: ${fields.join(', ')}.`;
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
    if (keep === 'ours') next.deletedAt = at;
    else delete next.deletedAt;
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
