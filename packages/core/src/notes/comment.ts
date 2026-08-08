/**
 * ADR-029 F3 — comments on a block, resolved and unresolved.
 *
 * **A comment is CONTENT, so it syncs, so it is stamped and merged like
 * everything else.** That sentence decides the whole shape: a comment carries
 * HLC stamps per field, it lives on the block record, and it goes through
 * `mergeNoteBlock` rather than through a second write path with its own ordering
 * rules.
 *
 * **Why it lives on the block and not as a child block.** A child would have
 * been the B4 answer — a page is a block, so why not a comment — and it breaks
 * C5 immediately: `deleteBlock` tombstones the subtree, so deleting the block
 * someone commented on would delete the comment with it. C5's rule is that
 * deleting the target of a link never deletes the link, and a comment is the
 * clearest possible link. Living on the block record, the comment survives on
 * the tombstone, and `commentsOnDeletedBlocks` is what makes it findable rather
 * than merely present.
 *
 * **Why per-field stamps inside a per-key map.** This is D4's per-field rule
 * taken one level down, exactly as E3's `props` took it: two people resolving
 * one comment and editing another are not in conflict, and one
 * `Stamped<Comment>` would make the later write take the whole record — so
 * resolving a thread on a phone would silently discard a correction typed on a
 * laptop a second earlier.
 *
 * Nothing here imports the block: the accessors take the structural shape they
 * need, so `block.ts` can hold the field without this file and that file
 * importing each other.
 */
import type { Hlc } from '../sync/hybridClock.js';
import { compareHlc } from '../sync/hybridClock.js';
import type { Stamped } from '../sync/stamped.js';

/**
 * A comment is a value, never a paragraph.
 *
 * Bounded here rather than trusted, because comment text reaches an agent's
 * context (C4) and a page's chrome. The limit is generous for a remark and far
 * short of a document — a comment that wants to be a page should be one.
 */
export const MAX_COMMENT_LENGTH = 4000;

/** Enough to say who without becoming a second identity system. */
export const MAX_COMMENT_AUTHOR = 120;

export interface NoteComment {
  id: string;
  /** The remark itself. Stamped, so an edit merges like any other prose field. */
  body: Stamped<string>;
  /**
   * Who wrote it, as a display name.
   *
   * Not stamped, because authorship is decided once and by one device: a field
   * two devices could rewrite would let the second one claim the first's
   * sentence, which is the one thing about a comment that must not be editable.
   */
  author: string;
  /**
   * When it was written. The value IS the stamp, like `NoteBlock.createdAt`, and
   * it is merged by the EARLIEST claim for the same reason.
   */
  createdAt: Hlc;
  /** F3's "resolved and unresolved". Stamped, so the state merges. */
  resolved: Stamped<boolean>;
  /**
   * A comment taken back, as a tombstone rather than a removed key.
   *
   * The same rule the block itself follows (C5): a removed key would leave a
   * peer's older edit of the comment arriving later with nothing to lose
   * against, and the comment would come back on its own.
   */
  deletedAt?: Hlc;
}

/** The structural shape every accessor here needs — never the whole block. */
export interface HasComments {
  comments?: Record<string, NoteComment>;
}

export function isLiveComment(comment: NoteComment): boolean {
  return !comment.deletedAt;
}

/**
 * A block's comments in the order they were written.
 *
 * Oldest first, because a thread reads forwards. Ordered by the creation stamp
 * rather than by insertion into the map: a comment that arrives from another
 * device lands in whatever key order JSON gives it, and a thread whose order
 * depends on sync timing reads as a different conversation on two screens.
 */
export function blockComments(block: HasComments): NoteComment[] {
  return Object.values(block.comments ?? {})
    .filter(isLiveComment)
    .sort((a, b) => compareHlc(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The remarks still in play.
 *
 * Its own function because two callers need exactly this set and would otherwise
 * each filter: the thread, and Q3's agent context — which deliberately carries
 * the OPEN comments only, since a settled remark is low-signal in exactly the
 * way ADR-028 D6 says makes a model worse at the lines that matter.
 */
export function unresolvedComments(block: HasComments): NoteComment[] {
  return blockComments(block).filter((comment) => comment.resolved.value !== true);
}

/**
 * C5 — a comment on a block that has been deleted.
 *
 * Deleting a target never deletes the link, so these still exist; the failure
 * this function prevents is that they exist and nobody can find them. A caller
 * shows them beside the trash, which is where a person looks for something that
 * was on a page that is gone.
 */
export function orphanedComments<T extends HasComments>(
  blocks: Iterable<T>,
  isLive: (block: T) => boolean,
): Array<{ block: T; comments: NoteComment[] }> {
  const out: Array<{ block: T; comments: NoteComment[] }> = [];
  for (const block of blocks) {
    if (isLive(block)) continue;
    const comments = blockComments(block);
    if (comments.length > 0) out.push({ block, comments });
  }
  return out;
}

/* ------------------------------------------------------------------- minting */

let commentCounter = 0;

/**
 * A comment id that carries the device that minted it.
 *
 * The same reasoning `newBlockId` states: comments merge by key into one map on
 * one record, so two devices minting the same id do not coexist — one comment
 * merges into the other and a person's remark disappears.
 */
export function newCommentId(deviceId: string, nowMs: number): string {
  commentCounter = (commentCounter + 1) % 100_000;
  return `cmt_${nowMs.toString(36)}${commentCounter.toString(36)}_${deviceId}`;
}

/** The bound applied wherever a comment body is written, client or server. */
export function boundCommentBody(text: unknown): string {
  return typeof text === 'string' ? text.slice(0, MAX_COMMENT_LENGTH) : '';
}

export function boundCommentAuthor(name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  return (raw || 'You').slice(0, MAX_COMMENT_AUTHOR);
}
