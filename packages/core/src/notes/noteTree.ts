/**
 * ADR-029 B4 + Q3 — one recursion for nesting, sub-pages and the sidebar tree,
 * and the bounded slice of it an agent is allowed to see.
 *
 * B4: a page is a block that has children, so there is no page type to build a
 * second traversal for. Everything below walks `parentId`.
 *
 * **Two hazards a flat parent pointer creates, both handled here rather than by
 * whoever renders the result:**
 *
 *  - A CYCLE. `parentId` merges by last-writer-wins per block, so two devices
 *    can concurrently move A under B and B under A, and each move wins its own
 *    field. The result is a loop that no sync bug caused and that a naive
 *    recursive build follows until the stack ends. A cycle is broken here, at
 *    the root, deterministically — both devices break it the same way, so they
 *    render the same tree.
 *  - A MISSING or DELETED parent. A child whose parent is gone would otherwise
 *    be unreachable from any root: present in the data, absent from the page.
 *    That is A3's quietly-wrong shape — content you will not notice is missing.
 *    Orphans surface at the top level instead, and the repair is REPORTED so it
 *    can be shown rather than inferred.
 */
import { isLiveBlock, type NoteBlock } from './block.js';
import { compareRank } from './rank.js';

export interface NoteTreeNode {
  block: NoteBlock;
  children: NoteTreeNode[];
  /** Nesting depth, 0 at the top. */
  depth: number;
}

export interface NoteTreeRepair {
  blockId: string;
  reason: 'cycle' | 'missing_parent' | 'deleted_parent';
  /** The parent the block claimed, so the repair can be explained or undone. */
  claimedParentId: string;
}

export interface NoteTree {
  roots: NoteTreeNode[];
  /** Blocks re-attached to the top level, with why. Empty is the normal case. */
  repairs: NoteTreeRepair[];
}

/**
 * Where a block's `parentId` actually resolves to, after repair.
 *
 * Separated from the build because search and context need the same answer
 * without paying for a whole tree — and because two implementations of "which
 * parent counts" would disagree about a cycle, which is the one case where
 * disagreeing produces two different documents.
 */
function resolveParents(blocks: Iterable<NoteBlock>): {
  live: Map<string, NoteBlock>;
  parentOf: Map<string, string | null>;
  repairs: NoteTreeRepair[];
} {
  const live = new Map<string, NoteBlock>();
  for (const block of blocks) if (isLiveBlock(block)) live.set(block.id, block);

  const deleted = new Set<string>();
  for (const block of blocks) if (!isLiveBlock(block)) deleted.add(block.id);

  const parentOf = new Map<string, string | null>();
  const repairs: NoteTreeRepair[] = [];

  for (const block of live.values()) {
    const claimed = block.parentId.value;
    if (claimed === null) { parentOf.set(block.id, null); continue; }
    if (!live.has(claimed)) {
      parentOf.set(block.id, null);
      repairs.push({
        blockId: block.id,
        reason: deleted.has(claimed) ? 'deleted_parent' : 'missing_parent',
        claimedParentId: claimed,
      });
      continue;
    }
    parentOf.set(block.id, claimed);
  }

  // Break cycles by detaching the member with the lowest id. Lowest id rather
  // than "the one we happened to visit first", because the choice has to be a
  // function of the data alone — otherwise two devices holding identical blocks
  // detach different members and show different trees while both are synced.
  for (const id of [...parentOf.keys()].sort()) {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id) ?? null;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        const member = [...seen].sort()[0]!;
        repairs.push({
          blockId: member,
          reason: 'cycle',
          claimedParentId: parentOf.get(member) as string,
        });
        parentOf.set(member, null);
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  return { live, parentOf, repairs };
}

/** The ordered tree of live blocks. */
export function buildNoteTree(blocks: Iterable<NoteBlock>): NoteTree {
  const { live, parentOf, repairs } = resolveParents(blocks);

  const childrenOf = new Map<string | null, NoteBlock[]>();
  for (const block of live.values()) {
    const parent = parentOf.get(block.id) ?? null;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(block);
    childrenOf.set(parent, bucket);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) =>
      compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
  }

  const build = (parent: string | null, depth: number): NoteTreeNode[] =>
    (childrenOf.get(parent) ?? []).map((block) => ({
      block,
      depth,
      children: build(block.id, depth + 1),
    }));

  return { roots: build(null, 0), repairs };
}

/** Every block in a subtree, the block itself first, in reading order. */
export function subtreeBlockIds(blocks: Iterable<NoteBlock>, rootId: string): string[] {
  const { live, parentOf } = resolveParents(blocks);
  if (!live.has(rootId)) return [];

  const children = new Map<string, NoteBlock[]>();
  for (const block of live.values()) {
    const parent = parentOf.get(block.id);
    if (typeof parent !== 'string') continue;
    const bucket = children.get(parent) ?? [];
    bucket.push(block);
    children.set(parent, bucket);
  }

  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    const kids = (children.get(id) ?? []).slice().sort((a, b) =>
      compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
    for (const kid of kids) walk(kid.id);
  };
  walk(rootId);
  return out;
}

/** The nearest ancestor of kind `page`, or the outermost ancestor if there is none. */
export function pageOf(blocks: Iterable<NoteBlock>, blockId: string): NoteBlock | null {
  const { live, parentOf } = resolveParents(blocks);
  let cursor: string | null = blockId;
  let outermost: NoteBlock | null = null;

  while (cursor !== null) {
    const block = live.get(cursor);
    if (!block) break;
    if (block.id !== blockId && block.kind.value === 'page') return block;
    outermost = block;
    cursor = parentOf.get(cursor) ?? null;
  }
  return outermost && outermost.id !== blockId ? outermost : null;
}

/**
 * The headings above a block, outermost first.
 *
 * Q3 chooses heading ancestry over neighbouring blocks, and the reason is worth
 * keeping next to the code: a heading tells you what the block is ABOUT, while
 * an adjacent paragraph only tells you what happens to sit next to it.
 */
export function headingAncestry(blocks: Iterable<NoteBlock>, blockId: string): NoteBlock[] {
  const { live, parentOf } = resolveParents(blocks);
  const chain: NoteBlock[] = [];

  let cursor: string | null = parentOf.get(blockId) ?? null;
  while (cursor !== null) {
    const block = live.get(cursor);
    if (!block) break;
    if (block.kind.value === 'heading' || block.kind.value === 'page') chain.unshift(block);
    cursor = parentOf.get(cursor) ?? null;
  }

  // A heading is often a SIBLING above rather than an ancestor, because a flat
  // page nests nothing. Take the nearest preceding heading among the siblings
  // so the block still has a place.
  const self = live.get(blockId);
  if (self) {
    const parent = parentOf.get(blockId) ?? null;
    const siblings = [...live.values()]
      .filter((b) => (parentOf.get(b.id) ?? null) === parent)
      .sort((a, b) => compareRank({ rank: a.rank.value, id: a.id }, { rank: b.rank.value, id: b.id }));
    const index = siblings.findIndex((b) => b.id === blockId);
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = siblings[i]!;
      if (candidate.kind.value === 'heading') { chain.push(candidate); break; }
    }
  }
  return chain;
}

/**
 * A block's text, capped.
 *
 * Q3 bounds the context at the block because a PAGE is unbounded. A block is
 * nearly bounded and not quite — a pasted code block or an imported transcript
 * paragraph has no limit either — so the cap is applied where the text is read
 * rather than trusted where it is written.
 */
export const MAX_CONTEXT_TEXT = 800;

export interface NoteBlockContext {
  block: NoteBlock;
  /** Outermost first, so the reader gets the page and then the section. */
  headings: string[];
  /** The block's text, truncated if it had to be. */
  text: string;
  truncated: boolean;
  /** Blocks on the same page that this context does NOT include. */
  omitted: number;
  /** The line that stands in for them, or null when there are none. */
  omittedLabel: string | null;
}

/**
 * Q3 — what resolving a note reference yields.
 *
 * The referenced block, the chain of headings above it, and a count of what was
 * left out. Never the page: someone's meeting notes run to thousands of words,
 * so "include the page" has no upper bound and would silently consume the
 * context belonging to the actual task. ADR-028 D6 set this precedent with
 * `MAX_LISTED_ITEMS`, on the evidence that fifty low-signal lines make a model
 * worse at the five that matter; it is applied here rather than re-litigated.
 *
 * The caller can always resolve a specific child to see more. What it cannot do
 * is get a page by accident.
 */
export function blockContext(blocks: Iterable<NoteBlock>, blockId: string): NoteBlockContext | null {
  const all = [...blocks];
  const block = all.find((b) => b.id === blockId && isLiveBlock(b));
  if (!block) return null;

  const headings = headingAncestry(all, blockId)
    .map((h) => h.text.value.trim())
    .filter((t) => t.length > 0);

  const page = pageOf(all, blockId);
  const pageSize = page ? subtreeBlockIds(all, page.id).length : all.filter(isLiveBlock).length;
  const omitted = Math.max(0, pageSize - 1);

  const raw = block.text.value;
  const truncated = raw.length > MAX_CONTEXT_TEXT;

  return {
    block,
    headings,
    text: truncated ? `${raw.slice(0, MAX_CONTEXT_TEXT)}…` : raw,
    truncated,
    omitted,
    omittedLabel: omitted > 0 ? `+${omitted} more block${omitted === 1 ? '' : 's'} on this page` : null,
  };
}
