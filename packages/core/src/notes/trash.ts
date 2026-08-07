/**
 * ADR-029 E4 + C5 — trash and favourites, both as projections.
 *
 * **Trash is not a table.** Deletion is already a tombstone (C5), so everything
 * a trash needs is already in the block store: the deleted blocks are the ones
 * with a tombstone in force, and restoring one is clearing that tombstone. A
 * `notes_trash` table would be a second place a deleted block can be, and the
 * two would disagree the first time a delete arrived from another device — the
 * block gone from the page and absent from the trash, which reads as data loss
 * whether or not anything was lost.
 *
 * The one judgement this file makes is what counts as an ENTRY. Deleting a page
 * tombstones its whole subtree (see `deleteBlock`), so a naive listing shows
 * forty rows for one gesture and restoring any single one of them puts a
 * paragraph back under a page that is still deleted. An entry is therefore the
 * ROOT of a deletion — a tombstoned block whose parent is not itself
 * tombstoned — and restoring it takes its subtree back with it, exactly as
 * deleting it took the subtree away.
 *
 * Favourites live here for the same reason: it is a projection over a stamped
 * field, not a list that has to be kept in step with the blocks it names.
 */
import { isFavourite, isLiveBlock, UNTITLED_PAGE, type NoteBlock } from './block.js';
import { compareRank } from './rank.js';
import { compareHlc, type Hlc } from '../sync/hybridClock.js';

export interface TrashEntry {
  block: NoteBlock;
  /** The tombstone in force. Present by construction — this is a deleted block. */
  deletedAt: Hlc;
  /** How many blocks come back with it. Zero for a single paragraph. */
  descendants: number;
}

/**
 * Every block that went away with `rootId`, the root first, in reading order.
 *
 * The tree builder only walks LIVE blocks, so it cannot answer this: by the
 * time a block is in the trash its children are tombstoned too and would be
 * invisible to `subtreeBlockIds`. Restoring without this walk would restore the
 * page and leave its contents deleted — a page that comes back empty, which is
 * the worst possible outcome of pressing "restore".
 */
export function deletedSubtreeIds(blocks: Iterable<NoteBlock>, rootId: string): string[] {
  const all = [...blocks];
  const root = all.find((block) => block.id === rootId);
  if (!root || isLiveBlock(root)) return [];
  return walkDeleted(deletedChildren(all), rootId);
}

/** The tombstoned blocks indexed by their claimed parent. Built once per read. */
function deletedChildren(blocks: readonly NoteBlock[]): Map<string, NoteBlock[]> {
  const childrenOf = new Map<string, NoteBlock[]>();
  for (const block of blocks) {
    if (isLiveBlock(block)) continue;
    const parent = block.parentId.value;
    if (parent === null) continue;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(block);
    childrenOf.set(parent, bucket);
  }
  return childrenOf;
}

function walkDeleted(childrenOf: Map<string, NoteBlock[]>, rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    // A cycle among tombstones is as possible as one among live blocks
    // (`parentId` is last-writer-wins per block), and it would hang a restore.
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    const kids = (childrenOf.get(id) ?? []).slice().sort((a, b) =>
      compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
    for (const kid of kids) walk(kid.id);
  };
  walk(rootId);
  return out;
}

/**
 * The trash, newest first.
 *
 * Newest first because the overwhelmingly common use is undoing something that
 * just happened; an alphabetical trash makes the person scan for a page they
 * deleted ten seconds ago.
 */
export function listTrashEntries(blocks: Iterable<NoteBlock>): TrashEntry[] {
  const all = [...blocks];
  const byId = new Map(all.map((block) => [block.id, block] as const));
  // Indexed ONCE. Re-deriving it per entry made listing the trash quadratic in
  // the number of tombstones, which is the one collection that only grows.
  const childrenOf = deletedChildren(all);

  const entries: TrashEntry[] = [];
  for (const block of all) {
    if (isLiveBlock(block) || !block.deletedAt) continue;
    const parentId = block.parentId.value;
    const parent = parentId === null ? undefined : byId.get(parentId);
    // Swept up with its parent rather than deleted in its own right. Listing it
    // would offer a restore that puts a paragraph under a deleted page.
    if (parent && !isLiveBlock(parent)) continue;

    entries.push({
      block,
      deletedAt: block.deletedAt,
      descendants: Math.max(0, walkDeleted(childrenOf, block.id).length - 1),
    });
  }

  return entries.sort((a, b) => compareHlc(b.deletedAt, a.deletedAt) || a.block.id.localeCompare(b.block.id));
}

/**
 * Where a restored block will land, or why it cannot land anywhere.
 *
 * Its old parent may itself be deleted, or may never have arrived on this
 * device. Reporting that lets the caller say "restored to the top level" rather
 * than putting the block somewhere the person did not expect and leaving them
 * to find it.
 */
export function restoreDestination(
  blocks: Iterable<NoteBlock>,
  id: string,
): { parentId: string | null; reparented: boolean } {
  const all = [...blocks];
  const block = all.find((candidate) => candidate.id === id);
  const claimed = block?.parentId.value ?? null;
  if (claimed === null) return { parentId: null, reparented: false };

  const parent = all.find((candidate) => candidate.id === claimed);
  if (parent && isLiveBlock(parent)) return { parentId: claimed, reparented: false };
  return { parentId: null, reparented: true };
}

/** The sidebar's favourites, in the order they sit in the document. */
export function favouriteBlocks(blocks: Iterable<NoteBlock>): NoteBlock[] {
  return [...blocks]
    .filter(isFavourite)
    .sort((a, b) => compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
}

/**
 * The line the trash shows for one entry. Says what comes back, not just what
 * went.
 *
 * Takes the count rather than the whole entry so every surface can call it —
 * the desktop host holds `TrashEntry` values, the browser harness holds a
 * flattened shape over the wire, and a second spelling of this sentence on the
 * surface that could not construct the argument is how one of them ends up
 * promising a restore the store does not perform.
 */
export function describeTrashEntry(entry: Pick<TrashEntry, 'descendants'>, title: string): string {
  const name = title.trim() || UNTITLED_PAGE;
  if (entry.descendants === 0) return name;
  return `${name} — and ${entry.descendants} block${entry.descendants === 1 ? '' : 's'} inside it`;
}
