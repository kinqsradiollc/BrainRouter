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
 *  - `props` (E3's property values) merges PER KEY, which is the same per-field
 *    rule applied one level down — see `mergeProps` for what a concurrent edit
 *    to one cell does and why. `schema` and `views` are last-writer-wins over
 *    the whole list, and `databaseOps.ts` states what that costs.
 *  - deletion resolves through the shared tombstone rule, so a block deleted on
 *    one device and typed into on another comes back marked rather than
 *    silently winning either way — EXCEPT when an explicit restore is newer
 *    than the tombstone, which is the one case where a person already decided.
 */
import { hlcAfter, hlcConcurrent, type Hlc } from '../sync/hybridClock.js';
import {
  latestStamp, mergeCompletion, mergeField, mergeText, resolveTombstone,
  type ConflictReason, type ConflictRecord, type Stamped,
} from '../sync/stamped.js';
import type { NoteBlock } from './block.js';
import type { NoteComment } from './comment.js';
import { unionSetValues, type NotePropertyValue } from './properties.js';

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
 * Placement (`parentId`, `rank`), `kind`, `level`, `checked` and E3's property
 * values stay last-writer-wins even when fenced, deliberately: a lost placement
 * is not a lost sentence, and neither is a lost cell. Someone whose block moved
 * drags it back in one gesture and can see that it moved; someone whose
 * paragraph was overwritten has no gesture and no notice. Marking those too
 * would put a conflict banner on a page for a checkbox, which is how people
 * learn to dismiss the banner that matters.
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
  const template = mergeField(ours.template, theirs.template);
  const checked = mergeCompletion(ours.checked, theirs.checked);
  const props = mergeProps(ours.props, theirs.props);
  const schema = mergeField(ours.schema, theirs.schema);
  const views = mergeField(ours.views, theirs.views);
  const createdAt = mergeCreation(ours.createdAt, theirs.createdAt);
  const comments = mergeComments(ours.comments, theirs.comments, conflicts);

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
    ...(template ? { template } : {}),
    ...(checked ? { checked } : {}),
    ...(props ? { props } : {}),
    ...(schema ? { schema } : {}),
    ...(views ? { views } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(comments ? { comments } : {}),
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
 * Merge a row's property values — E3, and D4's per-field rule one level down.
 *
 * **Per KEY.** Two devices setting two different properties of one row are not
 * in conflict, which is the same sentence B1 makes about two paragraphs of one
 * page. Merging the map as a single field would make the later write take the
 * whole map, so a status set on a phone would silently discard a due date typed
 * on a laptop a second earlier — with nothing marked, because nothing looked
 * like a conflict.
 *
 * **A concurrent edit to ONE property is last-writer-wins, and produces no
 * conflict marker.** That is the treatment `level`, `icon` and `checked` already
 * get, for two reasons that are specific to a cell:
 *
 *  - This function has ONE BLOCK, never the database, so it cannot know a
 *    property's type. A rule that varied by type — keeping both versions of a
 *    text cell the way `mergeText` keeps both versions of a paragraph — would
 *    need the schema to travel with every merge; and the schema is itself
 *    merged, so the rule for a value would depend on which version of the schema
 *    happened to win. A merge whose rules are decided by another merge is not a
 *    rule.
 *  - A cell is not a paragraph. B2's lease covers the whole row block, so the
 *    common multi-device case is prevented before it happens, and prose belongs
 *    in the row's page body — where the block IS the merge unit and `mergeText`
 *    does keep both versions.
 *
 * A cleared cell is stored as a stamped `null` rather than a removed key, so
 * clearing is an event that can win: a deleted key would leave a peer's older
 * "set" arriving later with nothing to lose against, and the value would come
 * back on its own.
 *
 * **The one exception is a SET, and it is F3's multi-select.** Two devices whose
 * writes never saw each other, each of which holds a list, are unioned rather
 * than decided — see `mergeCellValue`.
 */
function mergeProps(
  ours: NoteBlock['props'],
  theirs: NoteBlock['props'],
): NoteBlock['props'] | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;

  const merged: NonNullable<NoteBlock['props']> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const winner = mergeCellValue(ours[key], theirs[key]);
    if (winner) merged[key] = winner;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * One cell — last-writer-wins, except that two CONCURRENT set-valued writes
 * union.
 *
 * F3's multi-select is the case that forces this: two people tagging the same
 * row at the same moment both meant their tag, and last-writer-wins discards one
 * of them with nothing on either screen to say a tag was ever added. `{a}` and
 * `{b}` have an answer that loses nothing, and it is `{a, b}`.
 *
 * **Concurrent, not always.** A removal is a write of a smaller set, so a merge
 * that always unioned would make removing a tag impossible while any peer still
 * held the old list — the removal would come back on the next sync, forever. An
 * ordered pair therefore stays last-writer-wins and the union is reserved for
 * the tie, which is precisely the shape `mergeCompletion` already has.
 *
 * The rule keys on the value's SHAPE rather than on the property's type, because
 * this function has one block and never the database (see `mergeProps`). That is
 * not a compromise here: every set-valued type — multi-select, person, relation,
 * files — wants the same answer, and a scalar cell is never two arrays.
 */
function mergeCellValue(
  ours: Stamped<NotePropertyValue> | undefined,
  theirs: Stamped<NotePropertyValue> | undefined,
): Stamped<NotePropertyValue> | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  if (!Array.isArray(ours.value) || !Array.isArray(theirs.value)) return mergeField(ours, theirs);
  if (!hlcConcurrent(ours.at, theirs.at)) return mergeField(ours, theirs);

  // The stamp that would have won goes first, so two devices merging the same
  // pair in opposite directions produce the same array rather than two arrays
  // that are equal as sets and different as JSON — which would each look like a
  // fresh edit to the other and never settle.
  const leading = hlcAfter(theirs.at, ours.at) ? theirs : ours;
  const trailing = leading === ours ? theirs : ours;
  return {
    value: unionSetValues(leading.value as readonly string[], trailing.value as readonly string[]),
    at: leading.at,
  };
}

/**
 * F3 — the comments on a block, merged per comment and then per field.
 *
 * The same shape `mergeProps` has, one level further in, and for the identical
 * reason: two people resolving one comment and correcting another are not in
 * conflict, and merging the map as a single field would make the later write
 * take the whole thread.
 *
 * **A comment's BODY is prose, so it gets prose's rule.** `mergeText` keeps both
 * versions with a marker rather than silently discarding one, which is B1's
 * argument about paragraphs applied to the one other place in Notes where a
 * person types sentences. The conflict is filed under `comment:<id>` so a
 * surface can point at the thread rather than at the block in general — a
 * banner that says "this block has two versions" over a paragraph nobody touched
 * is how people learn to dismiss the banner.
 *
 * **Resolution ties toward UNRESOLVED, which is the opposite of `checked` and is
 * deliberate.** `mergeCompletion` ties a todo toward done because un-completing
 * finished work makes you doubt the record. A comment is the other way round: a
 * resolved comment disappears from the thread's default reading, so losing an
 * "I reopened this" hides a remark somebody deliberately brought back, while
 * losing a "resolved" costs one click on something still visible. The safe
 * direction is the one that leaves the conversation on screen.
 *
 * **A deletion wins over an edit, without a marker.** Unlike a block — where
 * `resolveTombstone` surfaces delete-versus-edit because a page is expensive to
 * lose — a comment is one remark whose author took it back, and resurrecting it
 * as a conflict would ask a person to re-decide something they decided. The
 * tombstone is kept rather than the key removed, so a peer's later edit has
 * something to lose against instead of recreating the comment.
 */
function mergeComments(
  ours: NoteBlock['comments'],
  theirs: NoteBlock['comments'],
  conflicts: Record<string, ConflictRecord>,
): NoteBlock['comments'] | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;

  const merged: NonNullable<NoteBlock['comments']> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const mine = ours[key];
    const yours = theirs[key];
    if (!mine || !yours) {
      const only = mine ?? yours;
      if (only) merged[key] = only;
      continue;
    }
    const body = mergeText(mine.body, yours.body);
    if (body.conflict) conflicts[commentConflictField(key)] = body.conflict;
    merged[key] = {
      id: mine.id,
      // The author and the creation are decided once, on one device. The
      // EARLIEST creation survives for `mergeCreation`'s reason, and the author
      // travels with it so the two cannot come apart.
      ...(hlcAfter(mine.createdAt, yours.createdAt)
        ? { author: yours.author, createdAt: yours.createdAt }
        : { author: mine.author, createdAt: mine.createdAt }),
      body: body.value ?? mine.body,
      resolved: mergeResolution(mine.resolved, yours.resolved),
      ...(latestStamp([mine.deletedAt, yours.deletedAt])
        ? { deletedAt: latestStamp([mine.deletedAt, yours.deletedAt])! }
        : {}),
    };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The conflict key a comment's kept-both body is filed under. */
export function commentConflictField(commentId: string): string {
  return `comment:${commentId}`;
}

/** `mergeCompletion` with the tie the other way — see `mergeComments`. */
function mergeResolution(ours: Stamped<boolean>, theirs: Stamped<boolean>): Stamped<boolean> {
  const sameClock = ours.at.physical === theirs.at.physical && ours.at.logical === theirs.at.logical;
  if (!sameClock) return hlcAfter(theirs.at, ours.at) ? theirs : ours;
  // The tie: whichever side says "still open" keeps the conversation visible.
  return ours.value === false ? ours : theirs;
}

/**
 * The newest stamp among the fields that count as WORK on the block.
 *
 * `collapsed`, `favourite` and `views` are excluded deliberately. This value is
 * what decides whether an edit outranks a tombstone, and folding a toggle,
 * pinning something to the sidebar or re-sorting a database view is not a reason
 * to resurrect a block someone deleted on another device — those are view
 * preferences that happened to be synced.
 *
 * `props` and `schema` ARE counted: setting a cell or adding a column is
 * somebody working on the row, and an edit made after a delete is exactly the
 * case `resolveTombstone` exists to surface rather than silently drop.
 *
 * **F3's `comments` are excluded, and that is C5 rather than an oversight.** A
 * comment is a link to the block, not an edit of it, so commenting must not
 * resurrect a block someone deleted on another device — the comment survives on
 * the tombstone and stays findable (`orphanedComments`), which is what "deleting
 * a target never deletes the link" means when the link is a remark.
 */
/**
 * F3 — creation is merged by the EARLIEST claim, which is the opposite of every
 * other field here and is not an inconsistency.
 *
 * A block is created once, on one device. Two stamps for one creation mean one
 * of them is a re-derivation — a peer that met the block for the first time in a
 * push and recorded when IT first saw it — and the earlier of the two is the
 * only one that can be the truth. Last-writer-wins would let a block's recorded
 * creation move forward every time a new device met it, which is a column
 * labelled "Created" whose value depends on who opened the app.
 */
function mergeCreation(ours: Hlc | undefined, theirs: Hlc | undefined): Hlc | undefined {
  if (!ours) return theirs;
  if (!theirs) return ours;
  return hlcAfter(ours, theirs) ? theirs : ours;
}

/**
 * F3 — when the block was last worked on, as the column reads it.
 *
 * The same stamp `resolveTombstone` compares against, exported rather than
 * re-derived: an "Edited" column that disagreed with the field deciding whether
 * an edit outranks a delete would be two answers to what an edit is.
 */
export function blockEditedAt(block: NoteBlock): Hlc | undefined {
  return latestBlockEdit(block);
}

/**
 * F4 — the newest stamp of ANY write to this block, which is not the same
 * question as "when was it last edited".
 *
 * A second function rather than a widening of `blockEditedAt`, because that one
 * feeds `resolveTombstone` and the Edited column, and both of those mean *work*:
 * a fold, a favourite or a delete is not work, and counting them there would
 * report a delete as an edit that outranks it and raise a conflict banner over a
 * collapsed toggle.
 *
 * The undo guard asks the other question — *has anything landed here from
 * another device since I recorded this step* — and for that a peer's tombstone
 * and a peer's renamed database view both count, because undoing over either one
 * destroys it. Undo used to resurrect a block a peer had deleted, and used to
 * write a peer's view configuration back to the one before it, for exactly the
 * fields this adds.
 */
export function blockWrittenAt(block: NoteBlock): Hlc | undefined {
  return latestStamp([
    latestBlockEdit(block),
    block.deletedAt, block.restoredAt,
    block.collapsed?.at, block.favourite?.at, block.template?.at, block.views?.at,
    ...Object.values(block.comments ?? {}).flatMap((comment) => [
      comment?.body?.at, comment?.resolved?.at, comment?.createdAt, comment?.deletedAt,
    ]),
  ]);
}

/**
 * F3 — when the block was made, and how sure we are.
 *
 * `exact` is false for a block written before `createdAt` existed. The fallback
 * is the earliest stamp the block still carries, which is a LOWER BOUND on its
 * creation and not the creation itself — an edit re-stamps the field it touched,
 * so a long-lived block's oldest surviving stamp drifts forward. It is reported
 * as approximate rather than shown as a date, because Part F's rule is that a
 * metadata column must not say something it cannot know, and the difference
 * between "made on the 4th" and "here by the 4th" is exactly the kind of small
 * lie a column like this exists to avoid.
 */
export function blockCreatedAt(block: NoteBlock): { at: Hlc; exact: boolean } | null {
  if (block.createdAt) return { at: block.createdAt, exact: true };
  const earliest = earliestBlockStamp(block);
  return earliest ? { at: earliest, exact: false } : null;
}

function earliestBlockStamp(block: NoteBlock): Hlc | undefined {
  const stamps = [
    block.parentId?.at, block.rank?.at, block.kind?.at, block.text?.at,
    block.level?.at, block.checked?.at, block.language?.at,
    block.icon?.at, block.cover?.at, block.schema?.at, block.views?.at,
    ...Object.values(block.props ?? {}).map((stamped) => stamped?.at),
  ].filter((stamp): stamp is Hlc => !!stamp);
  if (stamps.length === 0) return undefined;
  return stamps.reduce((a, b) => (hlcAfter(a, b) ? b : a));
}

function latestBlockEdit(block: NoteBlock): Hlc | undefined {
  return latestStamp([
    block.text?.at, block.parentId?.at, block.rank?.at,
    block.kind?.at, block.level?.at, block.checked?.at,
    block.language?.at, block.icon?.at, block.cover?.at,
    block.schema?.at,
    ...Object.values(block.props ?? {}).map((stamped) => stamped?.at),
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
  // F3 — a comment kept both ways is a fact about the THREAD, and saying
  // `comment:cmt_9f2` to a person is worse than saying nothing.
  const comments = fields.filter((field) => field.startsWith('comment:'));
  if (comments.length === fields.length) {
    return comments.length === 1
      ? 'A comment on this block was written in two places at once. Both versions are kept.'
      : `${comments.length} comments on this block were written in two places at once. Both versions are kept.`;
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
  // F3 — a comment's kept-both body is resolved into the comment it belongs to,
  // not into the block's text. A resolution that wrote the chosen remark over
  // the paragraph would answer a conflict by creating a worse one.
  if (field.startsWith('comment:')) {
    const commentId = field.slice('comment:'.length);
    const comment = block.comments?.[commentId];
    if (!comment) return null;
    next.comments = { ...block.comments, [commentId]: { ...comment, body: { value: String(chosen), at } } };
  }
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
