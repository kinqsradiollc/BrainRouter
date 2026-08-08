/**
 * ADR-029 F3 — a block's comment thread, as the surface reads it.
 *
 * The MODEL is core's (`notes/comment.ts`): a comment is stamped content that
 * merges per key, and whether it is resolved is a field two devices can
 * disagree about. What is decided here is the reading — which section a comment
 * belongs in, what the indicator says, and what a thread on a block that has
 * been deleted is called.
 *
 * Flat DTOs rather than core's `NoteComment`, for the reason every other view
 * model in this folder uses them: the stamps are a sync concern, and a renderer
 * that took `Stamped<string>` would have to know about hybrid logical clocks in
 * order to draw a line of text.
 *
 * **The one rule worth stating twice.** C5 says deleting the target of a link
 * never deletes the link, and a comment is a link. So a comment on a deleted
 * block still exists, and the failure mode this file guards against is that it
 * exists where nobody will look — which is the same as having discarded it.
 */

export interface NoteCommentDto {
  id: string;
  body: string;
  author: string;
  resolved: boolean;
  /** When it was written, from the creation stamp's physical time. */
  createdAtMs: number;
}

export interface CommentSections {
  /** The conversation still in progress, oldest first. */
  open: NoteCommentDto[];
  /** Settled, kept because a settled remark is still the record of a decision. */
  resolved: NoteCommentDto[];
}

/**
 * Split a thread into what still needs reading and what does not.
 *
 * Resolved comments are KEPT rather than hidden: "we decided not to" is the most
 * valuable sentence on many blocks, and a resolve that deleted it would make
 * people avoid the resolve button — at which point the open section stops
 * meaning anything.
 */
export function commentSections(comments: readonly NoteCommentDto[]): CommentSections {
  const ordered = [...comments].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  return {
    open: ordered.filter((comment) => !comment.resolved),
    resolved: ordered.filter((comment) => comment.resolved),
  };
}

/**
 * What the marker beside a block says, or null when there is nothing.
 *
 * The OPEN count leads. A block with one open remark and nine settled ones has
 * one thing that needs a person, and a badge reading "10" buries it.
 */
export function commentBadge(comments: readonly NoteCommentDto[]): string | null {
  if (comments.length === 0) return null;
  const open = comments.filter((comment) => !comment.resolved).length;
  if (open === 0) return `${comments.length} resolved`;
  return String(open);
}

/** The thread's heading, which names the state rather than the count alone. */
export function commentThreadTitle(comments: readonly NoteCommentDto[]): string {
  const open = comments.filter((comment) => !comment.resolved).length;
  if (comments.length === 0) return 'No comments yet';
  if (open === 0) return comments.length === 1 ? '1 comment, resolved' : `${comments.length} comments, all resolved`;
  if (open === comments.length) return open === 1 ? '1 comment' : `${open} comments`;
  return `${open} open of ${comments.length}`;
}

/**
 * Is this a comment worth sending?
 *
 * Whitespace only is not. A thread whose entries include three empty bubbles is
 * one people stop scrolling, and the block already carries an indicator that
 * would count them.
 */
export function canPostComment(draft: string): boolean {
  return draft.trim().length > 0;
}

export function resolveActionLabel(resolved: boolean): string {
  return resolved ? 'Reopen' : 'Resolve';
}

/** What the composer invites. Never "add a comment", which says only what the button does. */
export function commentPlaceholder(hasComments: boolean): string {
  return hasComments ? 'Reply' : 'Ask about this line, or say what you decided';
}

/* ------------------------------------------------- C5: the deleted target */

export interface OrphanedThreadDto {
  blockId: string;
  /** What the block said, so the remark has something to be about. */
  text: string;
  comments: NoteCommentDto[];
}

/**
 * The line shown over comments whose block is in the trash.
 *
 * Said in the surface rather than left implicit, because the alternative is a
 * thread that appears to be about nothing. A person reading "this number is
 * wrong" with no line above it cannot tell whether the block was deleted or the
 * app lost it — and one of those is a reason to restore, which the same panel
 * offers.
 */
export function orphanedThreadNote(thread: OrphanedThreadDto): string {
  const open = thread.comments.filter((comment) => !comment.resolved).length;
  const words = thread.text.trim();
  const about = words.length > 0
    ? `“${words.length > 60 ? `${words.slice(0, 59)}…` : words}”`
    : 'a block with no text';
  if (open === 0) return `${about} was deleted. Its comments are kept.`;
  return `${about} was deleted with ${open} comment${open === 1 ? '' : 's'} still open. `
    + 'Restoring the block brings the line back; the comments are here either way.';
}

/** The panel's own heading when there are threads with no block left. */
export function orphanedSectionTitle(threads: readonly OrphanedThreadDto[]): string | null {
  if (threads.length === 0) return null;
  return threads.length === 1
    ? 'One deleted block still has comments'
    : `${threads.length} deleted blocks still have comments`;
}
