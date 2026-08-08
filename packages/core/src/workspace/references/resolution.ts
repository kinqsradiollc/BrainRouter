/**
 * ADR-029 A3 + A4 — what a reference can turn out to be, and how it is said.
 *
 * A reference is live (A3): resolving it reads the target's CURRENT state, not
 * a copy taken when the link was written. So resolution has to be able to
 * report every way "current" can go, and each way has to be distinguishable
 * from the others, because collapsing any two of them misinforms the reader:
 *
 *   - **found** — here it is.
 *   - **denied** — A4. Something is there and you may not see it. Rendering the
 *     title leaks it; rendering nothing makes the document look different to
 *     different people with no indication why, which reads as corruption.
 *   - **gone** — A3/C5. The target was deleted. A tombstone, never `null` and
 *     never a throw: a dangling reference is information, and a silently
 *     vanished one is a hole the reader will not notice.
 *   - **unavailable** — not in the ADR's list, and required by the same
 *     argument that produced the other three. Q5 decides resolution is
 *     server-side because the dashboard has no local store; the inverse is also
 *     true — a `code/file/...` reference cannot resolve on a client with no
 *     workspace open, and a mode this build does not implement cannot resolve
 *     at all. Reporting either as `gone` would tell a person their file was
 *     deleted because they opened the wrong app.
 *
 * `denied` deliberately carries no payload. Not a label, not a timestamp, not a
 * kind beyond what the caller already had in the reference — because anything
 * that distinguishes "denied and exists" from "denied and does not exist" is
 * the leak A4 exists to prevent, and an optional field is exactly where that
 * leak gets added later by someone being helpful.
 */
import type { WorkspaceRef } from './ref.js';

/** How a mode's noun reads in a sentence. Unknown modes fall back to their own name. */
const MODE_NOUN: Readonly<Record<string, string>> = {
  chat: 'chat',
  code: 'code',
  track: 'track',
  meetings: 'meeting',
  planner: 'planner',
  notes: 'note',
  // ADR-030 Q4 — an attached document, addressable by outline and by part.
  document: 'document',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Labels are rendered inline, on one line, next to a person's own prose. */
const MAX_LABEL_LENGTH = 120;

/** A tombstone's own sentence comes first; the mode's addition rides behind it. */
const MAX_TOMBSTONE_DETAIL = 80;

export interface ResolvedWorkspaceTarget {
  /**
   * The one-line label C1's `describe` exists to produce. Already collapsed to
   * a single line — see `asInlineLabel`.
   */
  readonly label: string;
  /** The mode's own current representation. A3: read now, never stored on the link. */
  readonly state?: unknown;
  /** ISO 8601, when the mode knows it. */
  readonly updatedAt?: string;
}

/**
 * Why there is nothing to show.
 *
 * `pending` is Q2's named asynchronous case: a Track item that must exist on
 * GitHub before it has an identity here. The referring note is saved
 * immediately with a reference that resolves to this until the create lands,
 * rather than blocking the editor — and it is a tombstone reason rather than a
 * fourth status because to a reader it behaves exactly like one: the target is
 * not there yet, and the document says so.
 */
export type WorkspaceTombstoneReason = 'deleted' | 'never_existed' | 'pending';

export interface WorkspaceTombstone {
  readonly reason: WorkspaceTombstoneReason;
  /** ISO 8601. A3's "(deleted 4 Aug)" is only that useful because it has the date. */
  readonly at?: string;
  /** Extra human context, when the mode has some worth reading. */
  readonly detail?: string;
}

/**
 * `no_resolver_here` is structural — this client cannot answer, another can.
 * `resolver_failed` is transient — ask again. `no_history_here` is neither: the
 * surface that owns the target is right here and still cannot say what became
 * of it, because the record that would have said is missing (a code reference
 * in a folder that is not a repository). They render differently because a
 * person's next action differs: switch surface, wait, or accept that nothing
 * here knows.
 */
export type WorkspaceUnavailableReason =
  | 'no_resolver_here'
  | 'resolver_failed'
  | 'malformed_ref'
  | 'no_history_here';

export type WorkspaceResolution =
  | { readonly status: 'found'; readonly ref: WorkspaceRef; readonly target: ResolvedWorkspaceTarget }
  | { readonly status: 'denied'; readonly ref: WorkspaceRef }
  | { readonly status: 'gone'; readonly ref: WorkspaceRef; readonly tombstone: WorkspaceTombstone }
  | {
      readonly status: 'unavailable';
      /** Null only when the reference could not be parsed — there is no ref to report. */
      readonly ref: WorkspaceRef | null;
      readonly reason: WorkspaceUnavailableReason;
      readonly detail?: string;
    };

/* ----------------------------------------------------------- constructors */

/**
 * Constructors rather than object literals at every call site, so a resolver
 * cannot express "nothing" by returning `null` — there is no shape for it.
 */
export function resolvedFound(
  ref: WorkspaceRef,
  target: { label: string; state?: unknown; updatedAt?: string },
): WorkspaceResolution {
  const label = asInlineLabel(target.label) || fallbackLabel(ref);
  return { status: 'found', ref, target: { ...target, label } };
}

export function resolvedDenied(ref: WorkspaceRef): WorkspaceResolution {
  return { status: 'denied', ref };
}

export function resolvedGone(ref: WorkspaceRef, tombstone: WorkspaceTombstone): WorkspaceResolution {
  return { status: 'gone', ref, tombstone };
}

export function resolvedUnavailable(
  ref: WorkspaceRef | null,
  reason: WorkspaceUnavailableReason,
  detail?: string,
): WorkspaceResolution {
  return detail === undefined ? { status: 'unavailable', ref, reason } : { status: 'unavailable', ref, reason, detail };
}

/* --------------------------------------------------------------- wording */

/**
 * Every non-`found` sentence a surface shows, produced in ONE place.
 *
 * The wording is centralised rather than left to each mode because A4's
 * requirement is a property of the *product*, not of the planner: six modes
 * each writing their own "you can't see this" string is six chances for one of
 * them to write the title instead. A mode supplies the label for a target the
 * viewer may see, and nothing else.
 */
export function renderWorkspaceResolution(
  resolution: WorkspaceResolution,
  opts: { nowMs?: number } = {},
): string {
  switch (resolution.status) {
    case 'found':
      return resolution.target.label;
    case 'denied':
      // No noun from the reference either: "a planner item you do not have
      // access to" tells you a planner item exists.
      return 'an item you do not have access to';
    case 'gone':
      return renderTombstone(resolution.ref, resolution.tombstone, opts.nowMs ?? Date.now());
    case 'unavailable': {
      const noun = resolution.ref ? fallbackLabel(resolution.ref) : 'a reference';
      if (resolution.reason === 'malformed_ref') return 'a link that is not a valid reference';
      if (resolution.reason === 'no_resolver_here') return `${noun} (not available in this app)`;
      // Deliberately not "deleted": nothing here knows that, and claiming it
      // would be the accusation A3 rules out one status up.
      if (resolution.reason === 'no_history_here') return `${noun} (missing — nothing here records where it went)`;
      return `${noun} (could not be loaded)`;
    }
  }
}

/**
 * The tombstone's own sentence, plus whatever the mode had to add.
 *
 * `detail` is appended rather than dropped because the generic noun is thin
 * where the modes differ most: "code symbol (deleted 7 Aug)" does not say which
 * symbol, or from which file, and the reader's next action depends on both. It
 * goes through `asInlineLabel` for the same reason a found label does — the
 * text can name content somebody else wrote.
 */
function renderTombstone(ref: WorkspaceRef, tombstone: WorkspaceTombstone, nowMs: number): string {
  const noun = fallbackLabel(ref);
  const detail = tombstone.detail ? asInlineLabel(tombstone.detail, MAX_TOMBSTONE_DETAIL) : '';
  const suffix = detail ? ` — ${detail}` : '';
  if (tombstone.reason === 'pending') return `${noun} (being created…)${suffix}`;
  if (tombstone.reason === 'never_existed') return `${noun} (no longer exists)${suffix}`;
  const when = tombstone.at ? formatShortDate(tombstone.at, nowMs) : null;
  return when ? `${noun} (deleted ${when})${suffix}` : `${noun} (deleted)${suffix}`;
}

/** `planner item`, `note block`, `track work item`. */
function fallbackLabel(ref: WorkspaceRef): string {
  const noun = MODE_NOUN[ref.mode] ?? ref.mode;
  return `${noun} ${ref.kind.replace(/-/g, ' ')}`;
}

/**
 * `4 Aug`, and `4 Aug 2025` once the year stops being obvious.
 *
 * Hand-rolled rather than `Intl`, because the string is asserted in tests and
 * ICU data differs between the Node builds this package runs on — a date format
 * that renders differently on a teammate's machine is a flaky test, and a flaky
 * test gets deleted.
 */
function formatShortDate(iso: string, nowMs: number): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const year = d.getUTCFullYear();
  return year === new Date(nowMs).getUTCFullYear() ? base : `${base} ${year}`;
}

/**
 * C4 — a label is UNTRUSTED content, so it is neutralised before it is a line.
 *
 * The title of a mirrored Track item was written by whoever opened the issue;
 * a note's heading was pasted from a webpage. Rendered inline it lands in
 * somebody's document, and injected into a turn it lands in the agent's
 * context. Newlines are the sharp edge in both: one label with a `\n` breaks
 * out of the line it was given and reads as the document's own prose.
 */
export function asInlineLabel(value: string, maxLength = MAX_LABEL_LENGTH): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
