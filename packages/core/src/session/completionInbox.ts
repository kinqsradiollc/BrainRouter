/**
 * COMPLETION-FEEDBACK (0.4.14) — "background work reports back to the agent".
 *
 * When a DETACHED background actor finishes after the parent's turn has already
 * ended — a worker thread, a fire-and-forget `delegate_agent` child, or a
 * backgrounded workflow — there is no in-turn `wait_*` result to fold into the
 * conversation. This in-process queue closes that loop: the finishing actor
 * enqueues its result keyed by the PARENT session that launched it, and the
 * parent agent drains the queue at the start of its next turn and injects a
 * system message. The net effect mirrors how an in-turn `wait_worker` /
 * `wait_agents` result would land — the agent "hears back" even though its turn
 * was already over.
 *
 * In-process only: workers/children die with the CLI, so their feedback is only
 * meaningful within the same process. The store is a module singleton; nothing
 * is persisted to disk (the durable transcript/summary already lives in the
 * worker/session stores for `read_worker_summary` / `read_agent_transcript`).
 */

export type CompletionStatus = 'completed' | 'failed' | 'interrupted' | 'closed';

export interface AgentCompletion {
  kind: 'agent' | 'worker' | 'workflow';
  /** The actor id — worker id, child session id, or workflow slug. */
  id: string;
  status: CompletionStatus;
  /** Optional human label (role / goal) for a friendlier one-liner. */
  label?: string;
  /** Short result/summary text, when the actor produced one. */
  summary?: string;
  /** ISO timestamp the completion was recorded. */
  completedAt: string;
}

const inbox = new Map<string, AgentCompletion[]>();

/** Record a finished detached actor for its parent session to pick up next turn. */
export function enqueueCompletion(parentSessionKey: string | null | undefined, item: AgentCompletion): void {
  if (!parentSessionKey) return;
  const list = inbox.get(parentSessionKey);
  if (list) list.push(item);
  else inbox.set(parentSessionKey, [item]);
}

/** Non-destructive view of a session's pending completions. */
export function peekCompletions(parentSessionKey: string): AgentCompletion[] {
  const list = inbox.get(parentSessionKey);
  return list ? [...list] : [];
}

/** How many completions are waiting for a session (cheap; for footers/telemetry). */
export function pendingCompletionCount(parentSessionKey: string): number {
  return inbox.get(parentSessionKey)?.length ?? 0;
}

/** Take and clear a session's pending completions (returns [] when none). */
export function drainCompletions(parentSessionKey: string): AgentCompletion[] {
  const list = inbox.get(parentSessionKey);
  if (!list || list.length === 0) return [];
  inbox.delete(parentSessionKey);
  return list;
}

/**
 * Drop pending completions for specific actor ids — they were already delivered
 * to the parent in-turn (an explicit `wait_agent` / `wait_worker`), so the
 * next-turn feedback would be a duplicate.
 */
export function acknowledgeCompletions(parentSessionKey: string | null | undefined, ids: string[]): void {
  if (!parentSessionKey || ids.length === 0) return;
  const list = inbox.get(parentSessionKey);
  if (!list) return;
  const drop = new Set(ids);
  const kept = list.filter((c) => !drop.has(c.id));
  if (kept.length) inbox.set(parentSessionKey, kept);
  else inbox.delete(parentSessionKey);
}

const STATUS_GLYPH: Record<CompletionStatus, string> = {
  completed: '✓',
  failed: '✗',
  interrupted: '⚠',
  closed: '∅',
};

const SUMMARY_CHARS = 600;

function truncate(value: string, max: number): string {
  const v = value.trim();
  return v.length <= max ? v : v.slice(0, max - 1) + '…';
}

/**
 * Render drained completions as the system message injected into the parent's
 * next turn. Pure — unit-tested without the agent. Returns '' for an empty list
 * so the caller can skip injection.
 */
export function formatCompletionFeedback(items: AgentCompletion[]): string {
  if (!items.length) return '';
  const lines = items.map((it) => {
    const glyph = STATUS_GLYPH[it.status] ?? '•';
    const who = it.label ? `${it.id} (${it.label})` : it.id;
    const head = `  ${glyph} ${it.kind} ${who} — ${it.status}`;
    if (!it.summary) return head;
    const body = truncate(it.summary, SUMMARY_CHARS).replace(/\n/g, '\n      ');
    return `${head}\n      ${body}`;
  });
  return [
    'Background work you launched earlier finished since your last turn:',
    ...lines,
    'Fold these results into your reply as needed. For full detail call `read_worker_summary` (workers) or `read_agent_transcript` (agents). Do NOT re-spawn work that already completed.',
  ].join('\n');
}

/** Test hook — clear every queue. */
export function __resetCompletionInbox(): void {
  inbox.clear();
}
