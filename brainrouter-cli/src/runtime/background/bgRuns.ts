/**
 * CLI-4 (0.4.3) — background-run registry: the state model `/bg` / `/ps` /
 * `/fg` / `/stop` read.
 *
 * A detached turn becomes a `BgRun` row (run id + status + log path). This
 * module is the pure lifecycle + listing core; actually detaching the live
 * REPL turn (running it off the prompt, streaming logs to the transcript, and
 * reattaching with `/fg`) is the follow-up — it rearchitects the turn loop and
 * is best implemented + verified against a running session.
 */

export type BgRunStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface BgRun {
  id: string;
  label: string;
  status: BgRunStatus;
  startedAt: number;
  endedAt?: number;
  logPath?: string;
  error?: string;
}

export class BgRunRegistry {
  private runs = new Map<string, BgRun>();

  start(id: string, label: string, startedAt: number, logPath?: string): BgRun {
    const run: BgRun = { id, label, status: 'running', startedAt, logPath };
    this.runs.set(id, run);
    return run;
  }

  /** Move a run to a terminal state. No-op if unknown or already terminal. */
  private finish(id: string, status: BgRunStatus, endedAt: number, error?: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return false;
    run.status = status;
    run.endedAt = endedAt;
    if (error) run.error = error;
    return true;
  }

  markDone(id: string, endedAt: number): boolean { return this.finish(id, 'done', endedAt); }
  markFailed(id: string, endedAt: number, error: string): boolean { return this.finish(id, 'failed', endedAt, error); }
  markStopped(id: string, endedAt: number): boolean { return this.finish(id, 'stopped', endedAt); }

  get(id: string): BgRun | undefined { return this.runs.get(id); }
  list(): BgRun[] { return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt); }
  running(): BgRun[] { return this.list().filter((r) => r.status === 'running'); }
}

const STATUS_GLYPH: Record<BgRunStatus, string> = {
  running: '▶', done: '✓', failed: '✗', stopped: '■',
};

/** Render the run list for `/ps` (plain lines; caller colours). `nowMs` injected for testable durations. */
export function formatBgRuns(runs: BgRun[], nowMs: number): string[] {
  if (runs.length === 0) return ['No background runs.'];
  const lines: string[] = [];
  for (const r of runs) {
    const end = r.endedAt ?? nowMs;
    const secs = Math.max(0, Math.round((end - r.startedAt) / 1000));
    const err = r.error ? ` — ${r.error}` : '';
    lines.push(`${STATUS_GLYPH[r.status]} ${r.id}  ${r.status} · ${secs}s · ${r.label}${err}`);
  }
  return lines;
}
