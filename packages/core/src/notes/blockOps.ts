/**
 * ADR-029 E1 — the gestures, decided in core.
 *
 * Enter splits a block at the caret. Backspace at column zero merges it into the
 * one above. Tab nests it, Shift-Tab lifts it out. ⌘D duplicates, ⌘⇧↑ moves it
 * up. E1's parity test is that a person who already uses one of these apps can
 * type a page here without being taught anything, and these six gestures are
 * what that sentence means in practice.
 *
 * **Every one of them goes through `noteStore`'s existing mutations.** No new
 * write path: leases are still checked, clocks still stamp, the outbox still
 * queues one operation per block (B3). A split that wrote blocks directly would
 * be the one edit in the product that a lock could not refuse and a sync could
 * not order — and it is the edit people perform most often.
 *
 * **What is decided here rather than in a keydown handler:** whether Backspace
 * unstyles, outdents or merges; where a split's second half goes when the block
 * has children; whether the tail of a merge takes its children with it. These
 * are judgements, and a judgement made inside a component is one the dashboard
 * and the CLI will make differently — which shows up as the same keystroke
 * doing two things on two surfaces.
 *
 * Every operation returns what HAPPENED and where the caret goes, because
 * Backspace does one of four things and a caller that cannot tell which is a
 * caller that has to guess where to put the cursor.
 */
import {
  CONTINUING_KINDS, holdsProse, isCollapsed, isLiveBlock, STYLED_TEXT_KINDS,
  type NoteBlock, type NoteBlockKind,
} from './block.js';
import { UNDO_LABELS } from './noteHistory.js';
import {
  asOneUndo, createBlock, deleteBlock, moveBlock, readNotes, updateBlock,
  type BlockWriteResult,
} from './noteStore.js';
import { buildNoteTree, type NoteTreeNode } from './noteTree.js';
import { copySubtree } from './templates.js';

export type BlockOpAction =
  | 'split'
  | 'merge'
  /** Backspace turned a styled block back into a paragraph. */
  | 'unstyle'
  | 'indent'
  | 'outdent'
  | 'duplicate'
  | 'move'
  /** Backspace removed the textless block above rather than merging into it. */
  | 'remove-previous'
  /** Nothing to do — the gesture was legal and had no effect. */
  | 'noop';

export interface BlockOpOk {
  ok: true;
  action: BlockOpAction;
  /** Where the caret belongs afterwards, or null when nothing has focus. */
  focusId: string | null;
  /** The offset within that block's text. */
  caret: number;
  /** Set when the operation minted a block. */
  createdId?: string;
  /** Set when the operation tombstoned blocks. */
  removedIds?: string[];
}

export type BlockOpFailure =
  | { ok: false; reason: 'not_found'; detail: string }
  | { ok: false; reason: 'locked'; detail: string }
  | { ok: false; reason: 'not_splittable'; detail: string }
  | { ok: false; reason: 'refused'; detail: string };

export type BlockOpResult = BlockOpOk | BlockOpFailure;

/* -------------------------------------------------------------- reading aids */

interface Positioned {
  block: NoteBlock;
  parentId: string | null;
  depth: number;
  children: NoteBlock[];
}

/**
 * The document as a flat reading-order list, plus each block's place in it.
 *
 * Built from `buildNoteTree` rather than from raw `parentId` values so these
 * operations see the same repaired tree the page renders — otherwise Backspace
 * would merge into a block that is not the one visibly above, on any document
 * where a parent had gone missing.
 */
function layout(userId: string | undefined): { order: string[]; at: Map<string, Positioned> } {
  const blocks = Object.values(readNotes(userId).blocks);
  const tree = buildNoteTree(blocks);
  const order: string[] = [];
  const at = new Map<string, Positioned>();

  const walk = (nodes: readonly NoteTreeNode[], parentId: string | null): void => {
    for (const node of nodes) {
      order.push(node.block.id);
      at.set(node.block.id, {
        block: node.block,
        parentId,
        depth: node.depth,
        children: node.children.map((child) => child.block),
      });
      walk(node.children, node.block.id);
    }
  };
  walk(tree.roots, null);
  return { order, at };
}

function siblingsOf(at: Map<string, Positioned>, order: readonly string[], parentId: string | null): Positioned[] {
  return order
    .map((id) => at.get(id))
    .filter((entry): entry is Positioned => !!entry && entry.parentId === parentId);
}

/**
 * A table row is structurally fixed: it belongs to its table.
 *
 * A row is a child block, so without this every nesting gesture applies to it —
 * Shift-Tab would lift a row out of its table and leave it as a stray line of
 * pipe-delimited text, from a keystroke the person meant as "outdent". Rows
 * still REORDER with move up/down, because that is genuinely moving a row.
 */
function isTableRow(block: NoteBlock): boolean {
  return block.kind.value === 'table-row';
}

function failed(result: BlockWriteResult): BlockOpFailure | null {
  if (result.ok) return null;
  if (result.reason === 'locked') return { ok: false, reason: 'locked', detail: result.detail };
  if (result.reason === 'not_found') return { ok: false, reason: 'not_found', detail: 'That block is gone.' };
  return { ok: false, reason: 'refused', detail: result.detail };
}

const missing = (id: string): BlockOpFailure =>
  ({ ok: false, reason: 'not_found', detail: `No block ${id}.` });

/* ------------------------------------------------------------------- split */

/**
 * What the second half of a split becomes.
 *
 * A list continues itself, because the next line after a bullet is nearly
 * always another bullet. Everything else becomes a paragraph — splitting a
 * heading into two headings is the single most irritating thing a naive editor
 * does, and a todo continues UNCHECKED because the new line is new work.
 */
function continuationKind(kind: NoteBlockKind): NoteBlockKind {
  return CONTINUING_KINDS.includes(kind) ? kind : 'paragraph';
}

/**
 * Enter — the block becomes two.
 *
 * The head is written FIRST, so a lease refusal costs nothing: the block is
 * unchanged and no orphan carrying the tail has been created. Creating first
 * and updating second would leave the same sentence in two places whenever the
 * update was refused, which is worse than the keystroke doing nothing.
 *
 * Pressing Enter on an empty list item lifts it out of the list instead of
 * making another empty one. That is not a nicety — it is the only way out of a
 * list without reaching for the mouse, and its absence is noticed within about
 * four seconds of typing.
 */
export function splitBlock(
  userId: string | undefined,
  id: string,
  caret: number,
  nowMs: number,
): BlockOpResult {
  // F4 — Enter is TWO writes (the head is trimmed, the tail is created) and one
  // ⌘Z. Without the group the person would press undo, watch the tail vanish,
  // and be left with a truncated paragraph — which is worse than no undo,
  // because it looks like the editor ate half their sentence.
  return asOneUndo(userId, UNDO_LABELS.split, () => splitBlockNow(userId, id, caret, nowMs));
}

function splitBlockNow(
  userId: string | undefined,
  id: string,
  caret: number,
  nowMs: number,
): BlockOpResult {
  const { at } = layout(userId);
  const here = at.get(id);
  if (!here) return missing(id);

  const kind = here.block.kind.value;
  if (kind === 'code') {
    // A newline inside code is a newline, not a new block. Refused with a
    // reason so the caller inserts the character rather than silently doing
    // nothing and leaving the person pressing Enter harder.
    return { ok: false, reason: 'not_splittable', detail: 'Enter inside a code block adds a line.' };
  }

  // Enter in a table row adds a ROW, and never splits the cells: the row's text
  // is an encoding, and cutting it at a caret offset produces a row whose
  // columns have silently shifted.
  if (isTableRow(here.block)) {
    const created = createBlock(userId, { kind: 'table-row', text: '', parentId: here.parentId, after: id }, nowMs);
    return { ok: true, action: 'split', focusId: created.id, caret: 0, createdId: created.id };
  }

  // A divider, an image, a bookmark or a table has nothing to split, but Enter
  // still has to do something: an editor where a keystroke is inert leaves the
  // person stuck below the thing they just inserted with no way to keep typing.
  // A page gets its new paragraph INSIDE it, because Enter in a title is how
  // you start writing the page.
  if (!holdsProse(kind)) {
    const firstChild = here.children.find(isLiveBlock);
    const created = createBlock(userId, {
      kind: 'paragraph',
      text: '',
      ...(kind === 'page'
        // At the TOP of the page, not appended: Enter in a title means "start
        // writing here", and landing below existing content is a jump the
        // person did not ask for.
        ? { parentId: id, ...(firstChild ? { before: firstChild.id } : {}) }
        : { parentId: here.parentId, after: id }),
    }, nowMs);
    return { ok: true, action: 'split', focusId: created.id, caret: 0, createdId: created.id };
  }

  const text = here.block.text.value;
  const cut = Math.min(Math.max(Math.trunc(caret), 0), text.length);

  if (CONTINUING_KINDS.includes(kind) && text.trim().length === 0) {
    return here.depth > 0 ? outdentBlock(userId, id, nowMs) : unstyle(userId, id, nowMs);
  }

  const head = text.slice(0, cut);
  const tail = text.slice(cut);

  if (head !== text) {
    const trimmed = updateBlock(userId, id, { text: head }, nowMs);
    const refusal = failed(trimmed);
    if (refusal) return refusal;
  }

  // The tail becomes the FIRST CHILD when this block has visible children,
  // because that is where it lands in reading order. As a sibling it would
  // appear after everything nested underneath — the person presses Enter in the
  // middle of a paragraph and the second half turns up several lines down.
  const visibleChildren = here.children.filter(isLiveBlock);
  const nestUnder = visibleChildren.length > 0 && !isCollapsed(here.block);

  const created = createBlock(userId, {
    kind: continuationKind(kind),
    text: tail,
    ...(nestUnder
      ? { parentId: id, before: visibleChildren[0]!.id }
      : { parentId: here.parentId, after: id }),
  }, nowMs);

  return { ok: true, action: 'split', focusId: created.id, caret: 0, createdId: created.id };
}

/** Turn a styled block back into a paragraph, keeping its text and its place. */
function unstyle(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  const result = updateBlock(userId, id, { kind: 'paragraph' }, nowMs);
  const refusal = failed(result);
  if (refusal) return refusal;
  return { ok: true, action: 'unstyle', focusId: id, caret: 0 };
}

/* ------------------------------------------------------------------- merge */

/**
 * Backspace at column zero — and it does one of four things.
 *
 * In order, because each is the least destructive thing still available:
 *
 *  1. A styled block becomes a paragraph. The list marker disappears, the words
 *     stay. Nothing has been lost and the next Backspace can go further.
 *  2. A nested paragraph outdents. Same reasoning one level up.
 *  3. A textless block above (a divider, an image) is removed. There is nothing
 *     to merge INTO, and leaving the caret stuck below a divider that Backspace
 *     cannot pass is how an editor feels broken.
 *  4. The text is appended to the block above and this block goes.
 *
 * The children come with it in case 4, re-parented under the block that
 * absorbed the text. Refusing the merge instead would leave the person pressing
 * a key that does nothing with no explanation; dropping them would delete
 * content to save a paragraph.
 */
export function mergeIntoPrevious(
  userId: string | undefined,
  id: string,
  nowMs: number,
): BlockOpResult {
  // F4 — a merge is a write, N re-parents and a delete. One ⌘Z, or undo would
  // restore the deleted block while its text was still appended to the one
  // above, leaving the sentence in the document twice.
  return asOneUndo(userId, UNDO_LABELS.merge, () => mergeIntoPreviousNow(userId, id, nowMs));
}

function mergeIntoPreviousNow(
  userId: string | undefined,
  id: string,
  nowMs: number,
): BlockOpResult {
  const { order, at } = layout(userId);
  const here = at.get(id);
  if (!here) return missing(id);

  // A row leaves the table only by being removed, and only when it is empty.
  // Merging its text into the row above would join two encodings and shift
  // every column; outdenting it would strand it outside its table.
  if (isTableRow(here.block)) {
    if (here.block.text.value.length > 0) return { ok: true, action: 'noop', focusId: id, caret: 0 };
    const index = order.indexOf(id);
    const above = index > 0 ? order[index - 1]! : null;
    const removed = deleteBlock(userId, id, nowMs);
    return { ok: true, action: 'merge', focusId: above, caret: 0, removedIds: removed };
  }

  const kind = here.block.kind.value;
  if (STYLED_TEXT_KINDS.includes(kind)) return unstyle(userId, id, nowMs);
  if (here.depth > 0) return outdentBlock(userId, id, nowMs);

  const index = order.indexOf(id);
  const previousId = index > 0 ? order[index - 1] : undefined;
  if (!previousId) {
    // The first block of the document. There is nowhere above to go, and that
    // is a legal keystroke rather than an error.
    return { ok: true, action: 'noop', focusId: id, caret: 0 };
  }

  const previous = at.get(previousId)!;
  const previousKind = previous.block.kind.value;

  if (!holdsProse(previousKind)) {
    // An image's text is a URL, not somewhere to append a sentence — merging
    // into it would break the image and lose the paragraph in one keystroke.
    // So the block above is either removed or left alone, never written into.
    //
    // A page above holds someone's whole document, and a container with live
    // children holds its rows. Neither is something a Backspace aimed at the
    // block BELOW should be able to destroy.
    if (previousKind === 'page' || previous.children.some(isLiveBlock)) {
      return { ok: true, action: 'noop', focusId: id, caret: 0 };
    }
    const removed = deleteBlock(userId, previousId, nowMs);
    return { ok: true, action: 'remove-previous', focusId: id, caret: 0, removedIds: removed };
  }

  const joinAt = previous.block.text.value.length;
  const joined = previous.block.text.value + here.block.text.value;

  const written = updateBlock(userId, previousId, { text: joined }, nowMs);
  const refusal = failed(written);
  if (refusal) return refusal;

  for (const child of here.children.filter(isLiveBlock)) {
    moveBlock(userId, child.id, { parentId: previousId }, nowMs);
  }
  const removed = deleteBlock(userId, id, nowMs);

  return { ok: true, action: 'merge', focusId: previousId, caret: joinAt, removedIds: removed };
}

/* --------------------------------------------------------------- structure */

/**
 * Tab — nest under the sibling above.
 *
 * The previous SIBLING, not the previous block: nesting under whatever happens
 * to be above would let a top-level paragraph become a child of something three
 * levels deep in another branch, which is not a movement anyone asked for.
 */
export function indentBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return asOneUndo(userId, UNDO_LABELS.indent, () => indentBlockNow(userId, id, nowMs));
}

function indentBlockNow(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  const { order, at } = layout(userId);
  const here = at.get(id);
  if (!here) return missing(id);

  if (isTableRow(here.block)) return { ok: true, action: 'noop', focusId: id, caret: 0 };

  const siblings = siblingsOf(at, order, here.parentId);
  const index = siblings.findIndex((entry) => entry.block.id === id);
  const previous = index > 0 ? siblings[index - 1] : undefined;
  if (!previous) {
    // The first child of its parent has nothing to nest under. A legal
    // keystroke with nothing to do, not a failure to report.
    return { ok: true, action: 'noop', focusId: id, caret: 0 };
  }

  const moved = moveBlock(userId, id, { parentId: previous.block.id }, nowMs);
  const refusal = failed(moved);
  if (refusal) return refusal;
  return { ok: true, action: 'indent', focusId: id, caret: 0 };
}

/**
 * Shift-Tab — lift out, landing immediately after the old parent.
 *
 * "After the parent" rather than at the end of the grandparent's children,
 * because the block was visually just below its parent's other children and
 * appending would teleport it past every later sibling.
 */
export function outdentBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return asOneUndo(userId, UNDO_LABELS.outdent, () => outdentBlockNow(userId, id, nowMs));
}

function outdentBlockNow(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  const { at } = layout(userId);
  const here = at.get(id);
  if (!here) return missing(id);
  if (here.parentId === null) return { ok: true, action: 'noop', focusId: id, caret: 0 };
  if (isTableRow(here.block)) return { ok: true, action: 'noop', focusId: id, caret: 0 };

  const parent = at.get(here.parentId);
  const grandParentId = parent?.parentId ?? null;

  const moved = moveBlock(userId, id, { parentId: grandParentId, after: here.parentId }, nowMs);
  const refusal = failed(moved);
  if (refusal) return refusal;
  return { ok: true, action: 'outdent', focusId: id, caret: 0 };
}

/**
 * Move a block one position among its siblings.
 *
 * Stops at the ends rather than escaping into the parent's list. A gesture that
 * silently changes nesting level when it runs out of siblings is one people
 * stop trusting to be reversible.
 */
export function moveBlockBy(
  userId: string | undefined,
  id: string,
  direction: -1 | 1,
  nowMs: number,
): BlockOpResult {
  const { order, at } = layout(userId);
  const here = at.get(id);
  if (!here) return missing(id);

  const siblings = siblingsOf(at, order, here.parentId);
  const index = siblings.findIndex((entry) => entry.block.id === id);
  const target = siblings[index + direction];
  if (index < 0 || !target) return { ok: true, action: 'noop', focusId: id, caret: 0 };

  const moved = moveBlock(
    userId,
    id,
    direction < 0 ? { before: target.block.id } : { after: target.block.id },
    nowMs,
  );
  const refusal = failed(moved);
  if (refusal) return refusal;
  return { ok: true, action: 'move', focusId: id, caret: 0 };
}

export function moveBlockUp(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return moveBlockBy(userId, id, -1, nowMs);
}

export function moveBlockDown(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  return moveBlockBy(userId, id, 1, nowMs);
}

/**
 * Duplicate a block and everything under it.
 *
 * The subtree comes too, because duplicating a page that arrives empty is not
 * duplicating a page. Copies are minted through `createBlock`, so each one gets
 * its own device-stamped id and its own outbox entry — reusing ids with a
 * suffix would put two blocks with the same key on the server, where the merge
 * would silently make them one.
 */
export function duplicateBlock(userId: string | undefined, id: string, nowMs: number): BlockOpResult {
  const source = readNotes(userId).blocks[id];
  if (!source || !isLiveBlock(source)) return missing(id);

  // F3 — the copy is `copySubtree`, shared with template instantiation. It was
  // duplicated here first and the two came apart in exactly the way ADR-029 is
  // organised against: this one dropped a database's schema and its rows' cells,
  // and neither remapped a reference pointing INSIDE the copy — so duplicating a
  // page left both copies' internal links aimed at the original's blocks.
  const copied = copySubtree(userId, id, { after: id, label: UNDO_LABELS.duplicate }, nowMs);
  if (!copied.rootId) return { ok: false, reason: 'refused', detail: 'The block could not be copied.' };
  return { ok: true, action: 'duplicate', focusId: copied.rootId, caret: 0, createdId: copied.rootId };
}
