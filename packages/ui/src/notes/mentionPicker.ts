/**
 * ADR-029 E4 + E5 — `@` and `[[`, and the references they write.
 *
 * E4 lists both as editor parity. E5 is the reason they are worth more here than
 * in the app being compared to: an `@`-mention in this editor addresses the
 * whole workspace, so a note can name a planner item, a work item or a meeting
 * and not only another page. Restricting the picker to pages would be copying a
 * limitation.
 *
 * **What gets written is a Part A reference, never a title.** A `[[Some page]]`
 * link resolves by title, so renaming the page breaks every mention of it and
 * two pages with the same name are the same link. The picker writes
 * `@[label](brainrouter://…)` — an id — through core's `insertInlineLink`, so
 * the escaping, the syntax and the mention-versus-hyperlink decision are all
 * made in the one place E2 put them. A `[[…]]` a person types by hand still
 * parses; it is the PICKER that refuses to write one.
 */
import { insertInlineLink } from '@kinqs/brainrouter-core/notes/editing';
import { meetingUri, noteBlockUri, plannerItemUri, workItemUri } from './references.js';

export type MentionAs = 'mention' | 'page';

export interface MentionTrigger {
  /** Where the `@` or the first `[` is. */
  at: number;
  query: string;
  as: MentionAs;
}

/** Long enough for a page title, short enough not to survive a pasted paragraph. */
export const MAX_MENTION_QUERY = 48;

/**
 * Is the caret inside an `@` or a `[[`?
 *
 * `@` has to start the block or follow a space, or every email address in a note
 * would open a picker. `[[` needs no such rule — nobody types two brackets by
 * accident — and it is checked FIRST, because `[[@` is a page query about a
 * mention and not the other way round.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  if (typeof text !== 'string') return null;
  const at = Math.min(Math.max(Math.trunc(caret), 0), text.length);
  const before = text.slice(0, at);

  const brackets = before.lastIndexOf('[[');
  if (brackets >= 0) {
    const query = before.slice(brackets + 2);
    if (!query.includes(']') && query.length <= MAX_MENTION_QUERY && !query.includes('\n')) {
      return { at: brackets, query, as: 'page' };
    }
  }

  const sign = before.lastIndexOf('@');
  if (sign < 0) return null;
  if (sign > 0 && !/\s/.test(text[sign - 1]!)) return null;
  const query = before.slice(sign + 1);
  if (query.length > MAX_MENTION_QUERY) return null;
  // A space ends it: a name has one word here, and a person who typed "@ " has
  // moved on. Newlines end it for the same reason, one line further.
  if (/[\s@[\]]/.test(query)) return null;
  return { at: sign, query, as: 'mention' };
}

export interface MentionPick {
  uri: string;
  label: string;
}

/**
 * The trigger replaced by a live reference.
 *
 * Through core's writer, so the label is escaped on the way in and comes back
 * out as the characters the person picked — a work item called `**BR-1**` must
 * not arrive in the document as bold.
 */
export function applyMentionPick(
  text: string,
  trigger: MentionTrigger,
  pick: MentionPick,
  caret: number,
): { text: string; caret: number } {
  const openerLength = trigger.as === 'page' ? 2 : 1;
  const end = Math.min(Math.max(caret, trigger.at + openerLength + trigger.query.length), text.length);
  const written = insertInlineLink(
    { text, start: trigger.at, end },
    { target: pick.uri, label: pick.label, as: 'mention' },
  );
  return { text: written.text, caret: written.start };
}

/**
 * ⌘K — the selected words become the link's label.
 *
 * The same writer as the picker, over a range the person chose rather than a
 * marker they typed. Two functions would mean two answers to "is the label
 * escaped", and the one that forgot would put a work item called `**BR-1**`
 * into the document as bold.
 */
export function applyLinkToSelection(
  text: string,
  selection: { start: number; end: number },
  pick: MentionPick,
): { text: string; caret: number } {
  const label = pick.label || text.slice(selection.start, selection.end);
  const written = insertInlineLink(
    { text, start: selection.start, end: selection.end },
    { target: pick.uri, label, as: 'mention' },
  );
  return { text: written.text, caret: written.start };
}

/* ------------------------------------------------------------- candidates */

export interface MentionCandidate {
  uri: string;
  label: string;
  /** Which mode owns it — the word beside the row, so two `BR-1`s stay apart. */
  mode: string;
}

/**
 * What the four local stores offer, before filtering.
 *
 * Meetings are the one whose records live only on the server (they have no
 * local store to read), so they arrive already fetched rather than being read
 * here — the shape is the same and the caller decides what it can afford to ask
 * for.
 */
export interface MentionSources {
  pages?: readonly { id: string; title: string }[];
  /**
   * E3's databases, which the page list does not contain.
   *
   * A full-page database is a container a person opens like a page, and core
   * resolves a reference to one with its SHAPE rather than its one line of text.
   * Left out, the thing a workspace is most likely to be organised around is the
   * one thing `@` cannot name — and its title is core's decoded one, not the
   * block's own text, which is why it arrives here rather than being filtered
   * out of the page list.
   */
  databases?: readonly { id: string; title: string }[];
  planner?: readonly { id: string; title: string; completed?: boolean }[];
  workItems?: readonly { key?: string; id: string; title: string }[];
  meetings?: readonly { id: string; title: string }[];
}

function score(label: string, needle: string): number {
  const text = label.toLowerCase();
  if (needle.length === 0) return 1;
  if (text === needle) return 100;
  if (text.startsWith(needle)) return 80;
  if (text.split(/[\s\-_/]+/).some((word) => word.startsWith(needle))) return 50;
  if (text.includes(needle)) return 20;
  return 0;
}

/**
 * The rows the picker shows for what has been typed.
 *
 * Ranked the way the slash menu is — exact, then prefix, then a word, then
 * anywhere — because a person types the same few characters at both and a menu
 * that reordered between them would have to be learned twice. Ties keep source
 * order, so the list does not reshuffle as someone types a second character.
 */
export function mentionCandidates(
  sources: MentionSources,
  query: string,
  limit = 8,
): MentionCandidate[] {
  // Ranked on the plain title and DISPLAYED with whatever the mode adds to it.
  // Scoring the decorated label would push every completed task down the list
  // because of a tick nobody typed.
  const rows: Array<MentionCandidate & { title: string }> = [];
  for (const page of sources.pages ?? []) {
    rows.push({ uri: noteBlockUri(page.id), label: page.title, title: page.title, mode: 'page' });
  }
  for (const database of sources.databases ?? []) {
    rows.push({
      uri: noteBlockUri(database.id), label: database.title, title: database.title, mode: 'database',
    });
  }
  for (const item of sources.planner ?? []) {
    rows.push({
      uri: plannerItemUri(item.id),
      label: item.completed ? `✓ ${item.title}` : item.title,
      title: item.title,
      mode: 'planner',
    });
  }
  for (const item of sources.workItems ?? []) {
    rows.push({
      uri: workItemUri(item.key || item.id), label: item.title, title: item.title, mode: 'work item',
    });
  }
  for (const meeting of sources.meetings ?? []) {
    rows.push({ uri: meetingUri(meeting.id), label: meeting.title, title: meeting.title, mode: 'meeting' });
  }

  const needle = (query ?? '').trim().toLowerCase();
  return rows
    .map((row, index) => ({ row, index, score: score(row.title, needle) }))
    .filter((entry) => entry.score > 0 && entry.row.title.trim().length > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ row }) => ({ uri: row.uri, label: row.label, mode: row.mode }));
}
