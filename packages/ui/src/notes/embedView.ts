/**
 * ADR-029 A3/A4 + F3 — an embed renders its target, live, and says so when it cannot.
 *
 * An embed block's text is one workspace reference (A1). What it draws is the
 * target's CURRENT state, read now — A3's whole argument is that a snapshot taken
 * at insert time produces documents that are quietly wrong, and a note saying
 * "TODO: ship the parser" beside a task completed three weeks ago has actively
 * misinformed its reader.
 *
 * **The non-found states read as sentences, not as an empty box.** That is F3's
 * requirement and A3/A4's: a dangling reference is information, a silently
 * vanished one is a hole nobody notices, and something you may not see has to say
 * so rather than differ silently between two readers.
 *
 * The sentences themselves come from core's `renderWorkspaceResolution`, which is
 * the one place every mode's wording is decided (A4's argument: six modes each
 * writing their own "you can't see this" is six chances for one of them to write
 * the title instead). This file only decides which SHAPE the card takes.
 */

/** What `workspace-resolve` answers with. `line` is core's rendered sentence. */
export interface WorkspaceResolutionDto {
  resolution?: { status?: string; ref?: { mode?: string; kind?: string; id?: string } };
  line?: string;
}

export type EmbedState =
  /** No reference yet — the block offers the picker. */
  | { state: 'empty' }
  /** Text that is not a reference at all. */
  | { state: 'not-a-reference'; text: string; note: string }
  | { state: 'loading'; uri: string; label: string }
  /** The target is here. `label` is its live one-line description. */
  | { state: 'found'; uri: string; label: string; mode: string }
  /**
   * The target is gone, denied, or cannot be resolved by this client. One shape
   * for the three because the card is the same card — a sentence and the address
   * — and three shapes would tempt a renderer into drawing nothing for one.
   */
  | { state: 'unresolved'; uri: string; note: string; status: string };

export const EMBED_EMPTY_INVITATION =
  'Nothing embedded yet. Pick a task, a note, a meeting or a file — it stays live, not a copy.';

const REF_PATTERN = /^brainrouter:\/\/[a-z0-9-]{1,32}\/[a-z0-9-]{1,48}\/\S{1,512}$/i;

/** Is this text one workspace reference? Bounded, because it runs per render. */
export function isWorkspaceReference(text: string): boolean {
  const value = (text ?? '').trim();
  return value.length > 0 && value.length <= 700 && REF_PATTERN.test(value);
}

/** The mode segment, for the word above the card. Empty when it cannot be read. */
export function embedMode(uri: string): string {
  const match = /^brainrouter:\/\/([a-z0-9-]{1,32})\//i.exec((uri ?? '').trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * What the card draws.
 *
 * `answer` is null while the resolve is in flight. That is deliberately a
 * different state from a resolve that came back unresolved: showing the "gone"
 * sentence for half a second before the target appears would tell a reader their
 * task was deleted every time the page opened.
 */
export function embedState(text: string, answer: WorkspaceResolutionDto | null): EmbedState {
  const uri = (text ?? '').trim();
  if (!uri) return { state: 'empty' };

  if (!isWorkspaceReference(uri)) {
    return {
      state: 'not-a-reference',
      text: uri,
      note: 'An embed holds one workspace link. Pick something, or turn this back into text to keep what is written here.',
    };
  }

  if (!answer) return { state: 'loading', uri, label: 'Reading it now…' };

  const status = answer.resolution?.status ?? '';
  const line = (answer.line ?? '').trim();

  if (status === 'found') {
    return { state: 'found', uri, label: line || uri, mode: embedMode(uri) };
  }

  // Core's sentence, not one written here. An unknown status still renders it,
  // because a newer backend answering with a status this build does not know is
  // not a reason to draw an empty box.
  return {
    state: 'unresolved',
    uri,
    status: status || 'unavailable',
    note: line || 'This link could not be read here.',
  };
}

/**
 * What the button on an unresolved card offers.
 *
 * Nothing, when there is nothing useful to do — a denied reference has no action
 * a person can take from inside the note, and a button that does nothing is
 * worse than no button.
 */
export function embedRetryLabel(status: string): string | null {
  if (status === 'unavailable') return 'Try again';
  return null;
}
