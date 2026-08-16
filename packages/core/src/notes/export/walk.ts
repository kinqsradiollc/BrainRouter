/**
 * ADR-029 F3 — the ordered subtree both writers walk.
 *
 * One walk, so a Markdown export and a CSV export of the same page can never
 * contain different blocks or the same blocks in a different order. That is not
 * theoretical tidiness: the two files are meant to be the same document, and a
 * person comparing them to check the export worked is exactly who would be
 * misled by a divergence.
 *
 * The ORDER comes from `subtreeBlockIds` rather than from a second traversal
 * written here. It is the function the store already uses to decide what a
 * delete takes and what a duplicate copies, and it is the one that knows how
 * `buildNoteTree` repairs a cycle two devices produced concurrently. A private
 * walk would be a second answer to "what is inside this page", and the first
 * thing it would get wrong is the case nobody can reproduce.
 */
import { type NoteBlock } from '../block.js';
import { subtreeBlockIds } from '../noteTree.js';

export interface WalkedBlock {
  readonly block: NoteBlock;
  /** Depth BELOW the root, so the root itself is 0. */
  readonly depth: number;
}

export interface WalkedSubtree {
  readonly rows: readonly WalkedBlock[];
  /** True when the bound stopped the walk before the subtree ended. */
  readonly truncated: boolean;
  /** Everything under the root, whether or not the bound let it through. */
  readonly total: number;
}

/**
 * A page and everything under it, in reading order, with each block's depth.
 *
 * Depth is counted by climbing the parent chain until it leaves the subtree,
 * rather than tracked during a traversal, because the traversal is not ours.
 * The climb is bounded: two devices can concurrently reparent a pair of blocks
 * into each other, and while the tree builder repairs that, this must terminate
 * either way.
 */
export function walkSubtree(
  blocks: Iterable<NoteBlock>,
  rootId: string,
  limit: number,
): WalkedSubtree {
  const all = [...blocks];
  const ids = subtreeBlockIds(all, rootId);
  if (ids.length === 0) return { rows: [], truncated: false, total: 0 };

  const byId = new Map(all.map((block) => [block.id, block] as const));
  const inSubtree = new Set(ids);
  const kept = ids.slice(0, Math.max(1, limit));

  const rows: WalkedBlock[] = [];
  for (const id of kept) {
    const block = byId.get(id);
    if (!block) continue;
    let depth = 0;
    let cursor = block.parentId?.value ?? null;
    // The bound is the subtree's own size: a chain longer than that has repeated
    // a block, which is the cycle case.
    for (let hops = 0; cursor !== null && hops < ids.length; hops += 1) {
      if (!inSubtree.has(cursor)) break;
      depth += 1;
      cursor = byId.get(cursor)?.parentId?.value ?? null;
    }
    rows.push({ block, depth });
  }

  return { rows, truncated: ids.length > kept.length, total: ids.length };
}
