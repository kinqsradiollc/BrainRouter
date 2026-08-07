/**
 * ADR-029 Part B — the Notes mode's view model.
 *
 * Pure, for the same reason the planner's is: every judgement about what is
 * editable, what a block's placeholder says, which cross-mode moves a line
 * offers and how a conflict reads is testable without Electron, and the
 * component stays markup.
 *
 * Notes are USER-scoped (D1), so nothing here takes a workspace root. If a
 * function in this file ever needs one, the scoping has regressed the way
 * ADR-028 D9 recorded for the planner.
 */

export interface NoteBlockView {
  id: string;
  parentId: string | null;
  depth: number;
  kind: string;
  text: string;
  checked: boolean;
  level: number | null;
  hasChildren: boolean;
  /** References this block currently makes, canonically spelled (A2). */
  refs: string[];
  /** Fields whose merge could not be decided — the human picks (D4). */
  conflictFields: string[];
  /** B2's attribution when another device holds the lease, else null. */
  lockedBy: string | null;
}

export interface NoteTreeRepairView {
  blockId: string;
  reason: 'cycle' | 'missing_parent' | 'deleted_parent';
  claimedParentId: string;
}

/**
 * Indentation, capped.
 *
 * B4 makes nesting unbounded — a page is a block with children, all the way
 * down — but a screen is not. Past this depth further nesting stops adding
 * information and starts removing width from the text, so the visual depth
 * saturates while the real one keeps working.
 */
export const MAX_VISUAL_DEPTH = 8;

export function indentFor(depth: number): number {
  return Math.min(depth, MAX_VISUAL_DEPTH) * 18;
}

/** What an empty block invites, per kind. Never "type something". */
export function placeholderFor(kind: string): string {
  switch (kind) {
    case 'page': return 'Untitled page';
    case 'heading': return 'Section';
    case 'todo': return 'Something to do';
    case 'code': return 'Code';
    case 'quote': return 'Quoted';
    case 'embed': return 'Paste a brainrouter:// reference';
    default: return 'Write, or paste a link to anything in the workspace';
  }
}

/**
 * Why this block cannot be typed in, or null.
 *
 * B2 chose prevention over resolution: a block another device is editing is
 * read-only WITH an attribution, so the conflict never happens rather than
 * being merged afterwards. A silently disabled field would read as the app
 * being broken.
 */
export function readOnlyReason(block: NoteBlockView): string | null {
  if (block.lockedBy) return block.lockedBy;
  // A divider has nothing to type. Saying so is better than an input that
  // accepts text and discards it.
  if (block.kind === 'divider') return 'A divider holds no text';
  return null;
}

export function canEdit(block: NoteBlockView): boolean {
  return readOnlyReason(block) === null;
}

/**
 * The one state that cannot resolve itself, so the only one that gets a banner.
 *
 * D4 keeps both versions rather than discarding the loser; a conflict nobody is
 * shown is the same as having discarded it.
 */
export function conflictBanner(blocks: readonly NoteBlockView[]): string | null {
  const count = blocks.filter((b) => b.conflictFields.length > 0).length;
  if (count === 0) return null;
  return count === 1
    ? 'One block was edited in two places. Pick which version to keep.'
    : `${count} blocks were edited in two places. Pick which version to keep.`;
}

/** A repair explained, so a block that moved says why rather than looking dragged. */
export function repairNote(repair: NoteTreeRepairView): string {
  switch (repair.reason) {
    case 'deleted_parent':
      return 'Moved to the top level — the page it was on was deleted.';
    case 'missing_parent':
      return 'Moved to the top level — the page it was on has not arrived on this device yet.';
    case 'cycle':
      return 'Moved to the top level — it had been nested inside itself.';
  }
}

export function emptyMessage(): string {
  return 'Nothing written yet. Start typing, or link a task, a file or a conversation from anywhere in the workspace.';
}

/* ------------------------------------------------------- cross-mode moves */

/**
 * ADR-029 C2 — the moves a note LINE offers, and the mode that owns each.
 *
 * `mode`/`kind` are what the shared `workspace-create` verb takes, so a new
 * target is a row here rather than a new code path — which is the property C3
 * is after: the agent's `workspace_create` and this menu reach the same
 * registry, so neither can offer something the other cannot make.
 */
export interface NoteSendTarget {
  id: string;
  label: string;
  mode: string;
  kind: string;
}

export const NOTE_SEND_TARGETS: readonly NoteSendTarget[] = [
  { id: 'track', label: 'Make a work item', mode: 'track', kind: 'work-item' },
  { id: 'planner', label: 'Add to planner', mode: 'planner', kind: 'item' },
];

/**
 * Which moves this block can actually perform right now.
 *
 * An empty block has nothing to turn into anything, and offering the action
 * anyway produces a work item called "" that someone has to go and delete.
 */
export function sendTargetsFor(block: NoteBlockView): NoteSendTarget[] {
  return block.text.trim().length > 0 ? [...NOTE_SEND_TARGETS] : [];
}

/**
 * The line a reference chip shows before its label has been resolved.
 *
 * A3 makes references live, so the label arrives from a resolve rather than
 * from the link — which means there is a moment with no label. Showing the raw
 * URI in that moment is honest and stable; showing nothing makes the chip
 * appear to pop into existence.
 */
export function pendingRefLabel(uri: string): string {
  const withoutScheme = uri.replace(/^brainrouter:\/\//, '');
  return withoutScheme.length > 48 ? `${withoutScheme.slice(0, 47)}…` : withoutScheme;
}

/**
 * Which blocks the filter box leaves on screen.
 *
 * `matchIds` is null when nothing was typed, and that is not the same as an
 * empty set: no query shows everything, a query with no hits shows nothing.
 * Collapsing the two would make an empty search look like an empty document.
 *
 * The MATCHING itself is not done here. B5's ranking — prose over link-only,
 * earlier over later, an id like `BR-114` as well as the whole URI — lives in
 * core's `searchNotes`, so the desktop and any other client agree about what a
 * match is. A second scoring implementation in the renderer would rank the same
 * notes differently on two surfaces, which reads as one of them being broken.
 */
export function visibleBlocks(
  blocks: readonly NoteBlockView[],
  matchIds: ReadonlySet<string> | null,
): NoteBlockView[] {
  if (matchIds === null) return [...blocks];
  return blocks.filter((b) => matchIds.has(b.id));
}

/** A2's "what links here", said in words. Zero renders nothing at all. */
export function backlinkNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 block links here' : `${count} blocks link here`;
}
