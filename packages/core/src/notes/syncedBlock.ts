/**
 * ADR-029 F3 — synced blocks: one block, many places, one truth.
 *
 * F3 words it as "A3 applied inside Notes", and taking that literally is what
 * makes this small. A3 says a reference is LIVE, not a copy: embedding a planner
 * item shows the item's current state, and snapshotting at insert time produces
 * documents that are quietly wrong. A synced block is the same decision pointed
 * at a note block instead of at another mode — so it is a `reference`, and the
 * one thing this file must never do is duplicate content.
 *
 * > **The mirror stores an ADDRESS. It never stores the words.**
 *
 * That single rule buys the whole feature and every one of its edge cases:
 *
 *   - **Editing either place edits the one block.** Not because anything here
 *     redirects a write, but because there is nothing else to write to. A
 *     mirror's own `text` is a URI; the rows a reader sees under it carry the
 *     SOURCE's ids, so a surface that renders them is already editing the one
 *     truth. A design that copied the subtree would need a synchroniser, and the
 *     first missed edge is two paragraphs that used to be one.
 *   - **A2 holds unchanged.** The reference lives in the referring content, so
 *     "where else does this block appear" is `syncedMirrorsOf` — a query over
 *     content, never a stored back-edge that could disagree with the front one.
 *   - **C5 holds unchanged.** Deleting the source cannot empty the mirrors,
 *     because the mirrors never held anything: they render the tombstone, with
 *     its date, exactly as any other dangling reference does.
 *
 * **What a mirror does when the viewer cannot see the source (A4).** It says so
 * — "a block you do not have access to" — and it does not fall back to rendering
 * nothing. Rendering nothing makes one person's page look different from
 * another's with no indication why, which is how somebody concludes the document
 * is corrupted. On the desktop this state is unreachable by construction (notes
 * are user-scoped, D1, so every block in the local store is yours); it is the
 * server and the dashboard, which serve rows across a `(org_id, user_id)`
 * partition, that need it, and they get it from `canSee`.
 *
 * **A cycle is detected and named, never iterated** — F2's constraint about
 * formulas, which is the same constraint here for the same reason: a mirror of
 * an ancestor is a page that renders itself forever, and "it hung" is not a
 * sentence anybody can act on.
 */
import { isLiveBlock, NOTES_MODE, NOTE_BLOCK_KIND, type NoteBlock, noteBlockUri } from './block.js';
import { subtreeBlockIds } from './noteTree.js';
import { formatWorkspaceRef, parseWorkspaceRef, type WorkspaceRef } from '../workspace/references/ref.js';

/** The kind. Its `text` is the source's URI — an address, never prose. */
export const SYNCED_BLOCK_KIND = 'synced';

/**
 * How many mirrors deep a render may go before it stops and says so.
 *
 * A mirror inside a mirrored subtree is legitimate — a shared "how we deploy"
 * block can itself show a shared warning — so the bound is not one. It is small
 * because past it the reader has lost track of which document they are in, and
 * because every level multiplies the work of drawing a page.
 */
export const MAX_SYNCED_DEPTH = 3;

/**
 * How many blocks one mirror may bring onto a page.
 *
 * Q3's argument, applied to a render instead of to a context: a source page is
 * unbounded, so "show the source" has no upper limit and a person finds out by
 * watching the editor stop responding. What is left out is stated
 * (`omittedLabel`), never implied.
 */
export const MAX_SYNCED_BLOCKS = 200;

export type SyncedBlockState =
  /** No source picked yet — a mirror somebody has just inserted. */
  | { readonly status: 'empty' }
  /** The text is not a reference at all. */
  | { readonly status: 'malformed'; readonly detail: string }
  /** A well-formed reference to something that is not a note block. */
  | { readonly status: 'not_a_block'; readonly uri: string; readonly detail: string }
  /** A4 — the viewer may not see the source. Never the title, never nothing. */
  | { readonly status: 'denied'; readonly uri: string }
  /** C5 — the source is gone. The mirror says so; it does not empty itself. */
  | { readonly status: 'gone'; readonly uri: string; readonly at?: string }
  /** F2's constraint: named, not iterated. */
  | { readonly status: 'cycle'; readonly uri: string; readonly detail: string }
  | {
      readonly status: 'ready';
      readonly uri: string;
      readonly source: NoteBlock;
      /**
       * The source and its subtree, in reading order, bounded.
       *
       * Ids rather than blocks so a caller renders through whatever view model
       * it already has for a block — a mirrored row is an ordinary row of the
       * one true block, and a second shape for it would be the copy this file
       * exists to refuse.
       */
      readonly blockIds: readonly string[];
      /** Q3's rule — what was left out, said rather than implied. */
      readonly omittedLabel?: string;
    };

export function isSyncedBlock(block: NoteBlock): boolean {
  return block.kind.value === SYNCED_BLOCK_KIND;
}

/**
 * The reference a mirror holds, or null.
 *
 * Parsed rather than string-matched so a mirror pointing at a planner item is
 * `not_a_block` (a sentence that leads somewhere) rather than silently treated
 * as a block id that does not exist.
 */
export function syncedSourceRef(block: NoteBlock): WorkspaceRef | null {
  const parsed = parseWorkspaceRef((block.text?.value ?? '').trim());
  return parsed.ok ? parsed.ref : null;
}

/** The source block's id, when the mirror points at a note block. */
export function syncedSourceId(block: NoteBlock): string | null {
  const ref = syncedSourceRef(block);
  return ref && ref.mode === NOTES_MODE && ref.kind === NOTE_BLOCK_KIND ? ref.id : null;
}

/** The text a mirror stores in order to point at a block. One spelling, canonical. */
export function syncedRefText(sourceId: string): string {
  return noteBlockUri(sourceId);
}

export interface SyncedReadOptions {
  /** A4 — whether this viewer may see the source. Absent means "this store is yours". */
  canSee?: (ref: WorkspaceRef) => boolean;
  /** The mirrors already being rendered above this one, for cycle detection. */
  seen?: readonly string[];
  maxBlocks?: number;
}

/**
 * What this mirror currently shows.
 *
 * Total: every input produces a state with a sentence behind it, which is what
 * stops a surface inventing its own explanation for an empty render. The order
 * of the checks is deliberate — malformed before missing, denied before gone —
 * because "you cannot see it" and "it was deleted" are different facts and
 * answering the second when the first is true leaks the existence of the block
 * (A4's own argument).
 */
export function readSyncedBlock(
  blocks: Iterable<NoteBlock>,
  mirror: NoteBlock,
  opts: SyncedReadOptions = {},
): SyncedBlockState {
  const raw = (mirror.text?.value ?? '').trim();
  if (raw.length === 0) return { status: 'empty' };

  const parsed = parseWorkspaceRef(raw);
  if (!parsed.ok) {
    return {
      status: 'malformed',
      detail: 'A synced block points at another block by its brainrouter:// address, and this is not one.',
    };
  }
  const ref = parsed.ref;
  const uri = formatWorkspaceRef(ref);

  if (ref.mode !== NOTES_MODE || ref.kind !== NOTE_BLOCK_KIND) {
    return {
      status: 'not_a_block',
      uri,
      // Named rather than rendered as an embed, because the two are different
      // gestures: an embed SHOWS another mode's record, a synced block IS
      // another block of this document. Quietly doing the first when the second
      // was asked for is the substitution F1 is about.
      detail: `A synced block mirrors a note block. To show a ${ref.mode} ${ref.kind} here, use an embed.`,
    };
  }

  if (opts.canSee && !opts.canSee(ref)) return { status: 'denied', uri };

  const all = [...blocks];
  const source = all.find((candidate) => candidate.id === ref.id);
  if (!source) {
    // Never-existed and deleted-then-swept read the same from here, and the
    // sentence says the honest thing: this device does not have it.
    return { status: 'gone', uri };
  }
  if (!isLiveBlock(source)) {
    const at = source.deletedAt ? new Date(source.deletedAt.physical).toISOString() : undefined;
    return { status: 'gone', uri, ...(at ? { at } : {}) };
  }

  // The two cycles that matter, and they are the same test. A mirror inside its
  // own source renders the mirror inside itself; a chain of mirrors that comes
  // back to one already on the stack does the same thing more slowly.
  const ids = subtreeBlockIds(all, source.id);
  if (source.id === mirror.id || ids.includes(mirror.id)) {
    return {
      status: 'cycle',
      uri,
      detail: 'This shows a block that contains it, so it would render inside itself.',
    };
  }
  if ((opts.seen ?? []).includes(source.id)) {
    return {
      status: 'cycle',
      uri,
      detail: 'This is already being shown further up the page, so it would repeat forever.',
    };
  }

  const limit = Math.max(1, opts.maxBlocks ?? MAX_SYNCED_BLOCKS);
  const shown = ids.slice(0, limit);
  return {
    status: 'ready',
    uri,
    source,
    blockIds: shown,
    ...(ids.length > shown.length
      ? { omittedLabel: `+${ids.length - shown.length} more blocks in the original` }
      : {}),
  };
}

/**
 * The line a mirror renders when it has nothing to show — and the note under it
 * when it does.
 *
 * One function so the desktop, the dashboard and an export cannot describe the
 * same state in three different ways. A4's leak only has to happen on one
 * surface to have happened, and the surest way to keep three of them saying the
 * same sentence is for there to be one sentence.
 */
export function describeSyncedState(state: SyncedBlockState): string {
  switch (state.status) {
    case 'empty':
      return 'Pick a block to show here. Editing it in either place edits the one block.';
    case 'malformed':
      return state.detail;
    case 'not_a_block':
      return state.detail;
    case 'denied':
      // A4, word for word with every other denied reference: not the title, and
      // not nothing.
      return 'A block you do not have access to.';
    case 'gone':
      return state.at
        ? `The block this shows was deleted on ${state.at.slice(0, 10)}. It is not gone from here — restore it and this fills back in.`
        : 'The block this shows is not on this device. Nothing has been lost from here.';
    case 'cycle':
      return state.detail;
    case 'ready':
      return state.omittedLabel
        ? `Synced — editing this edits the original. ${state.omittedLabel}.`
        : 'Synced — editing this edits the original.';
  }
}

/**
 * A2 — every place this block is mirrored, derived from content.
 *
 * A query, never a stored edge. The classic notes-app failure is keeping the
 * link on both ends and letting them diverge, and a mirror is exactly the shape
 * that tempts you into it: the source "knows" it is shared. It does not, and
 * that is why this cannot go stale.
 */
export function syncedMirrorsOf(blocks: Iterable<NoteBlock>, sourceId: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const block of blocks) {
    if (!isSyncedBlock(block) || !isLiveBlock(block)) continue;
    if (syncedSourceId(block) === sourceId) out.push(block);
  }
  return out;
}

/**
 * C5, as the sentence to show BEFORE a delete.
 *
 * "Deleting the original must not silently empty the other places" is satisfied
 * by the tombstone alone — the mirrors say the block was deleted rather than
 * going blank. This is the other half: the person doing the deleting is the one
 * who does not know, and telling them afterwards is telling the wrong person at
 * the wrong time.
 *
 * `null` when nothing mirrors the block, so a caller renders nothing rather than
 * "0 other places".
 */
export function syncedDeleteNotice(blocks: Iterable<NoteBlock>, sourceId: string): string | null {
  const all = [...blocks];
  // The whole subtree, because deleting a block takes its children (deleteBlock's
  // own rule) — and a mirror of a child is emptied by deleting the parent just
  // as surely as a mirror of the block itself.
  const affected = new Set(subtreeBlockIds(all, sourceId));
  const mirrors = all.filter(
    (block) =>
      isSyncedBlock(block) &&
      isLiveBlock(block) &&
      !affected.has(block.id) &&
      affected.has(syncedSourceId(block) ?? ''),
  );
  if (mirrors.length === 0) return null;
  return mirrors.length === 1
    ? 'This block is shown in one other place. Deleting it leaves that place saying it was deleted.'
    : `This block is shown in ${mirrors.length} other places. Deleting it leaves them saying it was deleted.`;
}
