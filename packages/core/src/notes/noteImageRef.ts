/**
 * ADR-029 D3 + F3 — what an image block's text MEANS, and where the bytes live.
 *
 * D3: "an image pasted into three notes is one object with three references."
 * So an image block does not hold an image — it holds a REFERENCE to one, and
 * the object it names is an attachment record, which is the store this product
 * already has. Inventing a second blob store beside it is the thing D3 exists to
 * refuse: two stores need a rule for which one a note's picture is in, and the
 * first person who moves a note finds out nobody wrote one.
 *
 * The reference is spelled `attachment:<id>` in the block's own `text` field
 * rather than in a new stamped field, and that is deliberate: `text` already
 * merges, already travels the outbox, already carries the block's references
 * (A2). A parallel `imageId` would be a second field that has to agree with the
 * first, which is E2's argument about inline marks, one block kind over.
 *
 * **A pasted https:// address is not an image block that works.** The renderer's
 * content policy is `img-src 'self' data:`, so a remote address renders as
 * nothing at all — which is the broken-image glyph F1 forbids, wearing a
 * different hat. `parseNoteImage` reports that as its own case so the surface
 * can offer to fetch the picture INTO the store rather than pretending.
 */

/** The one spelling. Anything else in an image block's text is not a reference. */
export const NOTE_IMAGE_PREFIX = 'attachment:';

/**
 * Notes are user-scoped (D1) and attachments are recorded per session; a picture
 * in a note belongs to neither a chat nor a task, so it is filed under one
 * stable key. That key is also what the de-duplication looks within, so the same
 * image pasted into three notes finds the object the first paste created.
 */
export const NOTE_ATTACHMENT_SESSION = 'notes';

export type NoteImageSource =
  /** The block names a stored object — the only shape that renders. */
  | { kind: 'attachment'; id: string }
  /** A web address: reachable, but not renderable until it is stored (D3). */
  | { kind: 'remote'; url: string }
  /** Nothing chosen yet. Not a failure — an invitation. */
  | { kind: 'empty' }
  /** Text that is neither, so the block says what it is holding instead. */
  | { kind: 'unusable'; text: string };

/** The reference a stored attachment is named by. */
export function noteImageRef(attachmentId: string): string {
  return `${NOTE_IMAGE_PREFIX}${attachmentId}`;
}

/**
 * The id inside `attachment:<id>`, or null when the text is not one.
 *
 * Shared with F3's `files` property so a picture in a block and a file in a cell
 * are spelled the same way and read by the same function. D3 says one store;
 * two spellings of a reference into it is the same divergence wearing a
 * different hat, and the first person who moves a file between the two finds out
 * nobody wrote a rule.
 *
 * An id with a separator in it is refused: treating it as one of ours would hand
 * a path fragment to a store that reads by id.
 */
export function noteAttachmentId(text: string): string | null {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value.startsWith(NOTE_IMAGE_PREFIX)) return null;
  const id = value.slice(NOTE_IMAGE_PREFIX.length).trim();
  return /^[A-Za-z0-9._-]{1,120}$/.test(id) ? id : null;
}

/**
 * What an image block's text is.
 *
 * Total: every string maps to one of the four cases, because a block whose text
 * is unexpected still has to render something a person can act on.
 */
export function parseNoteImage(text: string): NoteImageSource {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length === 0) return { kind: 'empty' };
  if (value.startsWith(NOTE_IMAGE_PREFIX)) {
    const id = noteAttachmentId(value);
    return id ? { kind: 'attachment', id } : { kind: 'unusable', text: value };
  }
  if (/^https?:\/\//i.test(value)) return { kind: 'remote', url: value };
  return { kind: 'unusable', text: value };
}

