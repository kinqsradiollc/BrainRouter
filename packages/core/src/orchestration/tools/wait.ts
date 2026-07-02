import { formatSessionSummary, getSession, listSessions, updateSession, type ChildSessionRecord } from '../orchestrator.js';
import { readTranscriptEntries } from '../../session/sessionStore.js';
import { childSessionKey } from '../../mcp/mcpUtils.js';
import { aggregateChildUsage } from '../childAccounting.js';
import { acknowledgeCompletions } from '../../session/completionInbox.js';
import { removeChildWorktree, worktreePatchFile } from '../../worktree/worktreeIsolation.js';
import type { OrchestrationContext } from './context.js';
import { runningPromises } from './registry.js';
import { summarize } from './summarize.js';

export async function handleWaitBatch(args: any, ctx: OrchestrationContext): Promise<string> {
  const ids = Array.isArray(args?.ids) ? args.ids.map(String) : [];
  if (ids.length === 0) throw new Error('wait_agents requires a non-empty `ids` array.');
  const rawTimeoutMs = args?.timeoutMs === undefined ? 240_000 : Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 240_000;
  // ORCH-FIX — allSettled, not all: one child's wait rejecting must NOT reject
  // the whole batch (which would surface as a tool failure and lose the other
  // children's results). A rejected wait becomes a per-child error result.
  const results = await Promise.allSettled(
    ids.map(async (id: string) => {
      const single = await handleWait({ id, timeoutMs }, ctx);
      try {
        return JSON.parse(single);
      } catch {
        return { id, raw: single };
      }
    }),
  );
  const settled = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: ids[i], status: 'error', error: r.reason?.message ?? String(r.reason) },
  );
  // MAS-P4-T3: roll the children's usage into one total so the parent sees
  // the cost split (and offload savings) of the whole batch at a glance.
  const childTotals = aggregateChildUsage(settled);
  return JSON.stringify({ waited: settled.length, agents: settled, childTotals }, null, 2);
}

export function handleList(ctx: OrchestrationContext): string {
  const sessions = listSessions(ctx.workspaceRoot);
  return JSON.stringify(sessions.map(s => summarize(s)), null, 2);
}

export async function handleWait(args: any, ctx: OrchestrationContext): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) throw new Error('wait_agent requires an id.');
  const rawTimeoutMs = args.timeoutMs === undefined ? 120_000 : Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeoutMs) ? rawTimeoutMs : 120_000;

  const promise = runningPromises.get(id);
  if (promise) {
    // DESK-6 — a Stop makes the wait return immediately. The child is NOT
    // killed (it keeps running detached and auto-drains next turn via
    // lastTurnPendingChildIds); the parent just stops blocking on it.
    const interruptedJson = (): string => {
      const record = getSession(ctx.workspaceRoot, id);
      return JSON.stringify({
        id, status: 'interrupted', childStatus: record?.status ?? 'running',
        role: record?.role, label: record?.label,
        summary: 'Wait interrupted by user — the child keeps running in the background.',
      }, null, 2);
    };
    const sig = ctx.interruptSignal;
    if (sig?.aborted) return interruptedJson();
    const interruptRacer = sig
      ? new Promise<void>((resolve) => sig.addEventListener('abort', () => resolve(), { once: true }))
      : null;
    if (timeoutMs <= 0) {
      await (interruptRacer ? Promise.race([promise, interruptRacer]) : promise);
      if (sig?.aborted) return interruptedJson();
    } else {
      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      const racers: Promise<void>[] = [
        promise,
        new Promise<void>((resolve) => { timeout = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); }),
      ];
      if (interruptRacer) racers.push(interruptRacer);
      await Promise.race(racers);
      if (timeout) clearTimeout(timeout);
      if (sig?.aborted) return interruptedJson();
      if (timedOut) {
        const record = getSession(ctx.workspaceRoot, id);
        return JSON.stringify({
          id,
          status: 'timeout',
          childStatus: record?.status ?? 'unknown',
          role: record?.role,
          label: record?.label,
          summary: record ? formatSessionSummary(record) : `No child session with id ${id}.`,
        }, null, 2);
      }
    }
  }

  // Delivered in-turn — drop any pending next-turn feedback for this child.
  acknowledgeCompletions(ctx.parentSessionKey, [id]);

  const record = getSession(ctx.workspaceRoot, id);
  if (!record) {
    // ORCH-FIX — return a value, never throw: a missing record (closed / never
    // started / bad id) must not reject a wait batch and stall the parent.
    return JSON.stringify(
      { id, status: 'gone', summary: `No child session with id ${id} (closed, never started, or unknown id).` },
      null,
      2,
    );
  }
  return JSON.stringify(summarize(record, true), null, 2);
}

export function handleReadTranscript(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const limit = Number(args.limit ?? 40);
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  const childKey = childSessionKey(record.parentSessionKey, record.id);
  const transcriptRoot = record.childWorkspaceRoot ?? ctx.workspaceRoot;
  const entries = readTranscriptEntries(transcriptRoot, childKey, limit);
  return JSON.stringify({ id, entries }, null, 2);
}

export function handleClose(args: any, ctx: OrchestrationContext): string {
  const id = String(args.id ?? '');
  const record = getSession(ctx.workspaceRoot, id);
  if (!record) throw new Error(`No child session with id ${id}.`);
  // CODEX-WORKTREE-CLEANUP — explicit close also removes a lingering worktree
  // (e.g. a wait:false child the parent never drained). Idempotent: the spawn
  // finally usually removed it already, and removeChildWorktree no-ops if gone.
  const patch: Partial<ChildSessionRecord> = { status: 'closed', completedAt: new Date().toISOString() };
  if (record.childWorkspaceIsolation) {
    try {
      // Capture-only on manual close (no applyBack): the spawn lifecycle already
      // merged a cleanly-completed child. Close just GCs a lingering worktree and
      // preserves any unmerged work as a recovery patch for `git apply`.
      const cleanup = removeChildWorktree(record.childWorkspaceIsolation, {
        patchFile: worktreePatchFile(ctx.workspaceRoot, record.id),
      });
      if (cleanup.diff && !record.worktreeDiff) patch.worktreeDiff = cleanup.diff;
      if (typeof cleanup.changedFiles === 'number' && record.worktreeChangedFiles == null) patch.worktreeChangedFiles = cleanup.changedFiles;
      if (cleanup.patchPath && !record.worktreePatchPath) patch.worktreePatchPath = cleanup.patchPath;
    } catch { /* best-effort */ }
  }
  const next = updateSession(ctx.workspaceRoot, id, patch);
  return JSON.stringify(summarize(next, true), null, 2);
}
