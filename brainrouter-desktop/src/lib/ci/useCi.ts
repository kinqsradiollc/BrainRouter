/**
 * useCi — GitHub CI/CD state + host round-trips, self-contained (`ci:`-namespaced
 * query ids + its own onEvent subscription, like useEditor/TerminalPanel). Reads
 * go through the host gh endpoints (graceful fallback to empty when gh is
 * missing/unauthed); the only mutation is rerun-failed.
 */
import { useEffect, useRef, useState } from 'react';
import type { CheckRow } from './ciFormat.js';

export interface PrDetail {
  number?: number; state?: string; title?: string; url?: string;
  headRefName?: string; baseRefName?: string; isDraft?: boolean;
  author?: { login?: string };
}
/** A row in the "all open PRs" list (`gh pr list`) — includes the body so the
 *  Review panel can show PR content inline without a per-PR detail round-trip. */
export interface PrListItem {
  number: number; title: string; state?: string; url?: string;
  headRefName?: string; baseRefName?: string; isDraft?: boolean;
  author?: { login?: string }; updatedAt?: string; body?: string;
}
export interface RunRow {
  databaseId?: number; name?: string; displayTitle?: string; status?: string; conclusion?: string;
  workflowName?: string; headBranch?: string; event?: string; createdAt?: string; url?: string;
}
export interface RunDetail extends RunRow { jobs?: Array<{ name: string; status?: string; conclusion?: string }>; updatedAt?: string }

export interface CiApi {
  pr: PrDetail | null;
  prs: PrListItem[];
  checks: CheckRow[];
  runs: RunRow[];
  loading: boolean;
  ghReady: boolean;
  runDetail: RunDetail | null;
  runLog: string | null;
  expandedRunId: number | null;
  watching: number | null;
  error: string | null;
  refresh: () => void;
  expandRun: (id: number) => void;
  loadLog: (id: number, failedOnly?: boolean) => void;
  rerunFailed: (id: number) => void;
  toggleWatch: (id: number) => void;
}

export function useCi(opts?: { workspaceRoot?: string | null; onToast?: (msg: string) => void }): CiApi {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [prs, setPrs] = useState<PrListItem[]>([]);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [ghReady, setGhReady] = useState(true);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [runLog, setRunLog] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const optsRef = useRef(opts); optsRef.current = opts;
  const workspaceRootRef = useRef(opts?.workspaceRoot); workspaceRootRef.current = opts?.workspaceRoot;
  const pending = useRef(0);

  useEffect(() => {
    const off = window.brainrouter.onEvent((msg) => {
      const resultRoot = (msg as { workspaceRoot?: string }).workspaceRoot;
      if (resultRoot && workspaceRootRef.current && resultRoot !== workspaceRootRef.current) return;
      const e = msg.event as { kind: string; id?: string; result?: unknown };
      if (e.kind !== 'query-result' || !e.id || !e.id.startsWith('ci:')) return;
      const op = e.id.split(':')[1];
      const r = (e.result ?? {}) as Record<string, unknown>;
      const err = typeof r.error === 'string' ? r.error : '';
      if (err) { setError(err); setGhReady(false); }
      else if (op === 'pr' || op === 'prs' || op === 'checks' || op === 'runs') setError(null);
      if (op === 'pr') { setPr((r.pr as PrDetail) ?? null); tick(); }
      else if (op === 'prs') { setPrs((r.prs as PrListItem[]) ?? []); tick(); }
      else if (op === 'checks') { setChecks((r.checks as CheckRow[]) ?? []); if (Array.isArray(r.checks) && !err) setGhReady(true); tick(); }
      else if (op === 'runs') { setRuns((r.runs as RunRow[]) ?? []); tick(); }
      else if (op === 'detail') { setRunDetail((r.run as RunDetail) ?? null); }
      else if (op === 'log') { setRunLog(String(r.log ?? '') || (err ? `(${err})` : '(no log)')); }
      else if (op === 'rerun') {
        if ((r as { ok?: boolean }).ok) { optsRef.current?.onToast?.('Re-running failed jobs…'); setTimeout(refresh, 1500); }
        else optsRef.current?.onToast?.(`Rerun failed: ${String((r as { error?: string }).error ?? 'unknown')}`);
      }
    });
    return off;
  }, []);

  const tick = (): void => { pending.current = Math.max(0, pending.current - 1); if (pending.current === 0) setLoading(false); };

  const refresh = (): void => {
    setLoading(true); setError(null); pending.current = 4;
    window.brainrouter.send({ kind: 'query', id: 'ci:pr', name: 'git-pr-detail' });
    window.brainrouter.send({ kind: 'query', id: 'ci:prs', name: 'git-pr-list' });
    window.brainrouter.send({ kind: 'query', id: 'ci:checks', name: 'git-pr-checks' });
    window.brainrouter.send({ kind: 'query', id: 'ci:runs', name: 'git-actions-runs', args: { limit: 20 } });
  };
  // Quiet background poll — refetch the PR list + current-branch PR + checks
  // WITHOUT the loading spinner, so new/updated PRs and check results appear on
  // their own (no manual Refresh). Flicker-free: state only ever replaces on a
  // result, and `tick()` is a no-op here because `pending` stays 0.
  const quietRefresh = (): void => {
    window.brainrouter.send({ kind: 'query', id: 'ci:pr', name: 'git-pr-detail' });
    window.brainrouter.send({ kind: 'query', id: 'ci:prs', name: 'git-pr-list' });
    window.brainrouter.send({ kind: 'query', id: 'ci:checks', name: 'git-pr-checks' });
  };
  const expandRun = (id: number): void => {
    if (expandedRunId === id) { setExpandedRunId(null); return; }
    setExpandedRunId(id); setRunDetail(null); setRunLog(null);
    window.brainrouter.send({ kind: 'query', id: 'ci:detail', name: 'git-actions-run-detail', args: { id } });
  };
  const loadLog = (id: number, failedOnly = false): void => {
    setRunLog(null);
    window.brainrouter.send({ kind: 'query', id: 'ci:log', name: 'git-actions-run-log', args: { id, failedOnly } });
  };
  const rerunFailed = (id: number): void => {
    window.brainrouter.send({ kind: 'query', id: 'ci:rerun', name: 'action:git-actions-rerun-failed', args: { id } });
  };
  const toggleWatch = (id: number): void => {
    setWatching((w) => (w === id ? null : id));
  };

  // While watching a run, poll its detail every few seconds (flicker-free: we
  // replace state only on result). Stops when watching is cleared.
  useEffect(() => {
    if (watching == null) return;
    const t = setInterval(() => {
      window.brainrouter.send({ kind: 'query', id: 'ci:detail', name: 'git-actions-run-detail', args: { id: watching } });
      window.brainrouter.send({ kind: 'query', id: 'ci:runs', name: 'git-actions-runs', args: { limit: 20 } });
    }, 5000);
    return () => clearInterval(t);
  }, [watching]);

  // Auto-refresh the PR list + checks every 25s so new/updated PRs surface on
  // their own — no manual Refresh. Quiet (no spinner), so it never interrupts.
  useEffect(() => {
    const t = setInterval(quietRefresh, 25_000);
    return () => clearInterval(t);
  }, []);

  return { pr, prs, checks, runs, loading, ghReady, runDetail, runLog, expandedRunId, watching, error, refresh, expandRun, loadLog, rerunFailed, toggleWatch };
}
