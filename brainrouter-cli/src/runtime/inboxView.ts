/**
 * CLI-15 (0.4.3) — compact inbox pane: group messages by kind so a glance
 * tells you what's waiting (text / goal-handoff / memory-ref / tool-result /
 * delegate) instead of a flat undifferentiated list. Pure (no chalk) for
 * testability; the command handler colours headers.
 *
 * The `/inbox --watch` poll loop + inline handoff-accept build on this view.
 */

export interface InboxMessage {
  id: string;
  fromSessionKey: string;
  kind: string;
  payload?: any;
  createdAt: string;
}

/** Stable display order — handoffs first (most actionable), delegates last. */
const KIND_ORDER = ['goal-handoff', 'delegate', 'memory-ref', 'tool-result', 'text'];

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

function preview(m: InboxMessage, max = 70): string {
  const raw = m.kind === 'text' && typeof m.payload?.text === 'string'
    ? m.payload.text
    : m.kind === 'goal-handoff' && typeof m.payload?.goal === 'string'
      ? m.payload.goal
      : `(${m.kind} payload)`;
  const clean = raw.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export interface InboxGroup {
  kind: string;
  count: number;
  messages: InboxMessage[];
}

/** Group + order messages by kind. */
export function groupInboxByKind(messages: InboxMessage[]): InboxGroup[] {
  const byKind = new Map<string, InboxMessage[]>();
  for (const m of messages) {
    const g = byKind.get(m.kind);
    if (g) g.push(m);
    else byKind.set(m.kind, [m]);
  }
  return [...byKind.entries()]
    .map(([kind, msgs]) => ({ kind, count: msgs.length, messages: msgs }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/** Render the grouped pane as plain lines (caller colours non-indented headers). */
export function formatInboxPane(messages: InboxMessage[]): string[] {
  if (messages.length === 0) return ['Inbox empty.'];
  const groups = groupInboxByKind(messages);
  const summary = groups.map((g) => `${g.count} ${g.kind}`).join(' · ');
  const lines: string[] = [`${messages.length} message${messages.length === 1 ? '' : 's'} — ${summary}`, ''];
  for (const g of groups) {
    lines.push(`${g.kind} (${g.count})`);
    for (const m of g.messages) {
      lines.push(`  ${m.fromSessionKey.slice(0, 8)} · ${preview(m)} (${m.id.slice(0, 8)})`);
    }
  }
  return lines;
}
