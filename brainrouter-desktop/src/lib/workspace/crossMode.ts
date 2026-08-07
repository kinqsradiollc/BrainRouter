/**
 * ADR-029 C2 — the cross-mode moves, in one place.
 *
 * Every row of C2's table is "make a record in another mode, then cite it back
 * from where it came from", so every row is these two calls in that order.
 * Written once rather than per surface, because a second implementation is how
 * one surface starts creating records the others cannot find — and because the
 * verbs it calls are the SAME ones the agent's `workspace_create` /
 * `workspace_link` tools reach (C3). One vocabulary or none.
 *
 * The order is load-bearing and comes from Q2: `create` is synchronous and
 * returns the URI precisely so the caller can write the reference into its own
 * content. An async create that failed after the source was saved would leave a
 * note claiming a task that does not exist.
 */
import { bridgeQuery } from '../bridgeQuery.js';

export interface CrossModeCreate {
  mode: string;
  kind: string;
  /** The human's words — the checklist line, the action item, the conclusion. */
  title: string;
  /** Where it came from, so the new record is traceable back (A2). */
  from?: string;
  fields?: Record<string, unknown>;
}

export type CrossModeResult =
  | { ok: true; uri: string; linkedBack: boolean }
  | { ok: false; error: string };

/**
 * Create in the owning mode, then cite it from the source.
 *
 * `linkedBack` is false, not an error, when the source cannot hold a reference:
 * a chat turn and a meeting summary are records of what happened and are not
 * edited afterwards. The new task still exists and still names where it came
 * from, which is the half that matters.
 */
export async function createAndCite(input: CrossModeCreate): Promise<CrossModeResult> {
  type Created = { uri?: string; error?: string };
  const created: Created | null = await bridgeQuery<Created>('workspace-create', {
    mode: input.mode,
    kind: input.kind,
    title: input.title.trim(),
    ...(input.from ? { from: input.from } : {}),
    ...(input.fields ? { fields: input.fields } : {}),
  }).catch((err: unknown): Created => ({ error: err instanceof Error ? err.message : String(err) }));

  if (!created?.uri) return { ok: false, error: created?.error ?? 'The record could not be created.' };

  if (!input.from) return { ok: true, uri: created.uri, linkedBack: false };
  const linked = await bridgeQuery<{ linked?: boolean }>('workspace-link', {
    from: input.from, to: created.uri,
  }).catch(() => null);
  return { ok: true, uri: created.uri, linkedBack: linked?.linked === true };
}

/* ------------------------------------------------------------ addressing */

export function noteBlockUri(blockId: string): string {
  return `brainrouter://notes/block/${blockId}`;
}

export function plannerItemUri(itemId: string): string {
  return `brainrouter://planner/item/${itemId}`;
}

export function codeFileUri(relPath: string): string {
  return `brainrouter://code/file/${relPath}`;
}

/**
 * A declaration inside a file, which is the reference that survives an EDIT.
 *
 * `code/file/parser.ts#L59` means a different line the moment someone adds an
 * import above it — the reference still resolves and now points at the wrong
 * thing, which is A3's quietly-wrong failure with the file still in place. A
 * name is what the reader was actually pointing at, and resolution finds it
 * wherever it has moved to in the file.
 */
export function codeSymbolUri(relPath: string, symbol: string): string {
  return `brainrouter://code/symbol/${relPath}#${symbol}`;
}

export function meetingUri(meetingId: string): string {
  return `brainrouter://meetings/meeting/${meetingId}`;
}

/**
 * A conversation, NOT a turn.
 *
 * A turn has no stable id — transcript entries are unkeyed lines and the server
 * re-mints message ids on every sync — so `chat/turn/<session>/<n>` would
 * resolve by position and cite a different turn after a rewind. The session key
 * is stable, so citing "the conversation this was said in" is the claim the
 * data can actually support.
 */
export function chatSessionUri(sessionKey: string): string {
  return `brainrouter://chat/session/${sessionKey}`;
}

/* ------------------------------------------------------------- captures */

/**
 * The line a captured record carries.
 *
 * Trimmed to a title's length rather than the whole message, because the whole
 * point of the reference is that the source stays where it is — copying it
 * produces a second copy that drifts, which is the failure A3 names.
 */
const MAX_CAPTURE = 200;

export function asCaptureTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > MAX_CAPTURE ? `${line.slice(0, MAX_CAPTURE - 1)}…` : line;
}

/** C2 — Chat → Notes: a turn's conclusion becomes a note block, citing the turn. */
export function captureToNotes(text: string, from?: string): Promise<CrossModeResult> {
  return createAndCite({ mode: 'notes', kind: 'block', title: asCaptureTitle(text), ...(from ? { from } : {}) });
}

/** C2 — Chat → Planner: "remind me to…" becomes a task. */
export function captureToPlanner(text: string, from?: string): Promise<CrossModeResult> {
  return createAndCite({ mode: 'planner', kind: 'item', title: asCaptureTitle(text), ...(from ? { from } : {}) });
}
