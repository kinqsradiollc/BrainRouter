/**
 * CC-P11.1 — background shell runs (0.4.15 thread G).
 *
 * `run_command({ background: true })` detaches a shell command instead of
 * blocking the turn: stdout+stderr stream to a log file under the workspace
 * CLI state, an in-process registry tracks pid/status/exit code, and the new
 * `task_output` tool polls the log incrementally by byte offset (the
 * TaskOutput/BashOutput pattern). Approval gating happens BEFORE the branch in
 * agent.ts — a background command goes through exactly the same dangerous-
 * command resolution as a foreground one.
 *
 * In-process registry: like worker threads, a background shell dies with the
 * CLI process; the log file survives for post-hoc reading.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from '../../storage/store.js';

export type BgShellStatus = 'running' | 'done' | 'failed';

export interface BgShellRun {
  id: string;
  command: string;
  pid: number | null;
  status: BgShellStatus;
  exitCode: number | null;
  logPath: string;
  startedAt: number;
  endedAt?: number;
}

const runs = new Map<string, BgShellRun>();

/** Output chunk cap per task_output read. */
export const BG_OUTPUT_CHUNK_CHARS = 8_000;

export function startBackgroundShell(input: {
  command: string;
  cwd: string;
  workspaceRoot: string;
}): BgShellRun {
  const id = `bgsh_${randomUUID().slice(0, 8)}`;
  const logDir = path.join(getStateDir(input.workspaceRoot), 'bgshell');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${id}.log`);
  const fd = fs.openSync(logPath, 'a');

  // `detached: true` puts the shell in its OWN process group, so killing the
  // group (negative pid) takes down the whole tree — `sh -c "npm run dev"` AND
  // the node it spawns — instead of orphaning the real server (WS2 2.4 / WS6 6.3).
  const child = spawn('sh', ['-c', input.command], {
    cwd: input.cwd,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  ensureExitCleanup();
  const run: BgShellRun = {
    id,
    command: input.command,
    pid: child.pid ?? null,
    status: 'running',
    exitCode: null,
    logPath,
    startedAt: Date.now(),
  };
  runs.set(id, run);

  child.on('exit', (code) => {
    run.status = code === 0 ? 'done' : 'failed';
    run.exitCode = code;
    run.endedAt = Date.now();
    try { fs.closeSync(fd); } catch { /* already closed */ }
  });
  child.on('error', () => {
    run.status = 'failed';
    run.endedAt = Date.now();
    try { fs.closeSync(fd); } catch { /* already closed */ }
  });
  return run;
}

export function getBackgroundShell(id: string): BgShellRun | undefined {
  return runs.get(id);
}

export function listBackgroundShells(): BgShellRun[] {
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Terminate a running background shell and its whole process tree (WS2 2.4 /
 * WS6 6.3). The shell is spawned `detached`, so a negative-pid signal hits the
 * process GROUP — `npm run dev` and the node it launched both die, nothing
 * orphans. Idempotent: a no-op (returns false) for an unknown or already-ended
 * run. The `exit` handler still flips status, but we set it eagerly for instant
 * UI feedback.
 */
export function killBackgroundShell(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  const run = runs.get(id);
  if (!run || run.status !== 'running' || run.pid == null) return false;
  try {
    process.kill(-run.pid, signal); // negative pid → the whole process group
  } catch {
    try { process.kill(run.pid, signal); } catch { /* already gone */ }
  }
  run.status = 'failed';
  run.endedAt = Date.now();
  return true;
}

/** Kill every running background shell. Returns how many were signalled. Used by
 *  the desktop "Stop all" path and the on-exit cleanup. */
export function killAllBackgroundShells(signal: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0;
  for (const run of runs.values()) {
    if (run.status === 'running' && killBackgroundShell(run.id, signal)) n += 1;
  }
  return n;
}

// Detached children survive their parent's group, so reap them when the host
// process exits cleanly — otherwise a normal quit would leave dev servers
// running. (Signal-based teardown is left to the CLI/host's own SIGINT handling
// so we don't fight it; a hard SIGKILL of the host is an unavoidable OS edge.)
let exitCleanupInstalled = false;
function ensureExitCleanup(): void {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', () => {
    for (const run of runs.values()) {
      if (run.status === 'running' && run.pid != null) {
        try { process.kill(-run.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
}

export interface BgOutputRead {
  id: string;
  status: BgShellStatus;
  exitCode: number | null;
  chunk: string;
  /** Pass back as `fromByte` on the next call to read only new output. */
  nextOffset: number;
  /** True when the run is terminal AND the chunk reaches the end of the log. */
  complete: boolean;
}

/** Incremental log read from `fromByte`. Never throws on a missing log. */
export function readBackgroundOutput(id: string, fromByte = 0): BgOutputRead | null {
  const run = runs.get(id);
  if (!run) return null;
  let buf = '';
  let size = fromByte;
  try {
    const st = fs.statSync(run.logPath);
    size = st.size;
    if (size > fromByte) {
      const fd = fs.openSync(run.logPath, 'r');
      try {
        const len = Math.min(size - fromByte, BG_OUTPUT_CHUNK_CHARS);
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, fromByte);
        buf = b.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch { /* log unreadable — return status only */ }
  const nextOffset = fromByte + Buffer.byteLength(buf, 'utf-8');
  return {
    id,
    status: run.status,
    exitCode: run.exitCode,
    chunk: buf,
    nextOffset,
    complete: run.status !== 'running' && nextOffset >= size,
  };
}

/** Test hook — clear the registry (log files are left to the temp dir). */
export function __resetBackgroundShells(): void {
  runs.clear();
}
