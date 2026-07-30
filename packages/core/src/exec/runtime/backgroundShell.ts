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
import { nodeBackgroundShellHost as host } from './backgroundShell/host/nodeBackgroundShellHost.js';

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
  const id = host.createId();
  const child = host.start({ ...input, id });
  ensureExitCleanup();
  const run: BgShellRun = {
    id,
    command: input.command,
    pid: child.pid,
    status: 'running',
    exitCode: null,
    logPath: child.logPath,
    startedAt: host.now(),
  };
  runs.set(id, run);

  child.onExit((code) => {
    run.status = code === 0 ? 'done' : 'failed';
    run.exitCode = code;
    run.endedAt = host.now();
    child.closeLog();
  });
  child.onError(() => {
    run.status = 'failed';
    run.endedAt = host.now();
    child.closeLog();
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
  host.killProcessTree(run.pid, signal);
  run.status = 'failed';
  run.endedAt = host.now();
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
  host.onExit(() => {
    for (const run of runs.values()) {
      if (run.status === 'running' && run.pid != null) {
        host.killProcessTree(run.pid, 'SIGKILL');
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

/** Byte length of the largest prefix of `b[0..len)` that ends on a complete
 *  UTF-8 character boundary. Returns `len` when the last char is whole (or the
 *  bytes are malformed — let the decoder cope), otherwise the offset just before
 *  the incomplete trailing lead byte so those bytes can be re-read next call. */
function utf8CompletePrefixLen(b: Buffer, len: number): number {
  if (len <= 0) return 0;
  let i = len - 1;
  while (i >= 0 && (b[i] & 0xc0) === 0x80) i--; // walk back over continuation bytes
  if (i < 0) return len;
  const lead = b[i];
  let expected: number;
  if ((lead & 0x80) === 0x00) expected = 1;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;
  else return len; // invalid lead byte
  return (len - i) >= expected ? len : i;
}

/** Incremental log read from `fromByte`. Never throws on a missing log. */
export function readBackgroundOutput(id: string, fromByte = 0): BgOutputRead | null {
  const run = runs.get(id);
  if (!run) return null;
  let buf = '';
  let size = fromByte;
  // Advance the cursor by the EXACT number of raw bytes consumed, not by the
  // byte length of the decoded string: a multibyte char split across the chunk
  // boundary decodes to U+FFFD (a longer byte sequence), and the old
  // `fromByte + Buffer.byteLength(buf)` overshot it and silently dropped output.
  let nextOffset = fromByte;
  try {
    const read = host.readLog(run.logPath, fromByte, BG_OUTPUT_CHUNK_CHARS);
    size = read.size;
    if (read.bytes.length > 0) {
      const b = Buffer.from(read.bytes);
      const len = b.length;
      // Hold an incomplete trailing multibyte char for the next read — UNLESS
      // the run is finished and we're at EOF (a truncated final write must be
      // emitted so polling completes instead of stalling forever).
      const atEof = fromByte + len >= size;
      const terminal = run.status !== 'running';
      const complete = utf8CompletePrefixLen(b, len);
      const emit = complete < len && !(atEof && terminal) ? complete : len;
      buf = b.subarray(0, emit).toString('utf-8');
      nextOffset = fromByte + emit;
    }
  } catch { /* log unreadable — return status only */ }
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
