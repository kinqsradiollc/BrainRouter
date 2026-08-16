/**
 * ADR-029 D3 + F3 — what an image block draws, and what it says when it cannot.
 *
 * **Never a broken-image glyph.** That is the requirement this file exists for.
 * A browser's broken image tells a reader that something is wrong and nothing
 * about what — and in this app there are four genuinely different reasons a
 * picture is not on screen, each with a different next action: nothing has been
 * chosen yet, the object is being read, the object is not on this machine, or
 * the block is holding text that is not a picture at all. Collapsing those into
 * one grey square is F1's defect in miniature.
 *
 * **The bytes are the attachment store's (D3).** An image block holds
 * `attachment:<id>`; the picture itself is one content-addressed object however
 * many notes point at it. `parseNoteImage` in core owns that spelling, so the
 * renderer and the host cannot disagree about what a block's text means.
 *
 * **A workspace is a place a picture can be, and the note is not.** Notes are
 * user-scoped (D1) and attachments are stored per workspace, so a note opened
 * from a different checkout can hold a reference whose bytes are elsewhere.
 * That is stated rather than hidden: `missing` says so in a sentence, because a
 * reader who is told "this picture was added from a different workspace" knows
 * what to do and a reader shown a grey square does not.
 *
 * Pure — the read is a host handler, and this only says what to draw.
 */
import { parseNoteImage } from '@kinqs/brainrouter-core/notes/editing';

/** `notes-image-read`'s answer. `dataUri` is absent when the blob is not here. */
export interface NoteImageDto {
  id: string;
  name: string;
  dataUri?: string;
  width?: number;
  height?: number;
  byteSize?: number;
  /** Present when the record or its bytes could not be read here. */
  error?: string;
}

export type NoteImageState =
  /** Nothing chosen. The block offers the picker and the paste. */
  | { state: 'empty' }
  /** A stored object, being read. */
  | { state: 'loading'; id: string }
  | { state: 'ready'; id: string; src: string; alt: string; width?: number; height?: number }
  /** The reference is good; the bytes are not here. Says which. */
  | { state: 'missing'; id: string; note: string }
  /** A web address. Reachable, not renderable — offer to store it (D3). */
  | { state: 'remote'; url: string; note: string }
  /** Text that is neither, so the block says what it is holding. */
  | { state: 'unusable'; text: string; note: string };

export const IMAGE_EMPTY_INVITATION = 'No picture yet. Choose a file, or paste one straight in.';

/**
 * The renderer's content policy allows `self` and `data:` only, so a remote
 * address cannot be drawn even though it can be fetched. Saying that — and
 * offering the fetch — is honest; leaving an `<img>` pointed at it would be the
 * broken glyph with extra steps.
 */
export const IMAGE_REMOTE_NOTE =
  'This is a web address. Store the picture with your notes and it will be kept once, however many notes use it.';

export function imageMissingNote(name: string | undefined, detail: string | undefined): string {
  const called = name ? ` (${name})` : '';
  if (detail) return `This picture${called} is not on this machine — ${detail}`;
  return `This picture${called} was added somewhere this app cannot read from here. Open the note where it was added, or choose the file again.`;
}

/**
 * What the block draws.
 *
 * `answer` is null while the read is in flight, which is a different state from
 * a read that came back with nothing — the first shows the frame, the second
 * shows the sentence.
 */
export function imageState(text: string, answer: NoteImageDto | null): NoteImageState {
  const source = parseNoteImage(text ?? '');

  if (source.kind === 'empty') return { state: 'empty' };
  if (source.kind === 'remote') return { state: 'remote', url: source.url, note: IMAGE_REMOTE_NOTE };
  if (source.kind === 'unusable') {
    return {
      state: 'unusable',
      text: source.text,
      note: 'This line is not a picture. Choose a file, or turn the block back into text to keep what is written here.',
    };
  }

  if (!answer || answer.id !== source.id) return { state: 'loading', id: source.id };
  if (!answer.dataUri) return { state: 'missing', id: source.id, note: imageMissingNote(answer.name, answer.error) };

  return {
    state: 'ready',
    id: source.id,
    src: answer.dataUri,
    // The file's own name is the alt text: it is the only description anybody
    // supplied, and an empty alt on a picture in a document is a picture a
    // screen reader cannot mention at all.
    alt: answer.name || 'Picture',
    ...(answer.width === undefined ? {} : { width: answer.width }),
    ...(answer.height === undefined ? {} : { height: answer.height }),
  };
}

/**
 * Which of a paste's items is a picture.
 *
 * Returns the first image item rather than all of them: a paste carrying one
 * picture in three formats (PNG, TIFF, and a screenshot's own) is one picture,
 * and storing three would be D3's failure caused by the very gesture D3 names.
 */
export function firstImageItem(items: readonly { kind: string; type: string }[]): number {
  return items.findIndex((item) => item.kind === 'file' && item.type.startsWith('image/'));
}

/** A dropped or pasted file that is not a picture, said plainly. */
export function notAPictureNote(name: string, type: string): string {
  const called = name || 'that file';
  return type
    ? `${called} is a ${type}, not a picture.`
    : `${called} is not a picture.`;
}
