/**
 * ADR-050 P2 — a persistent child process that exchanges newline-delimited
 * messages over stdio. The shared substrate every structured transport reuses
 * (Claude stream-json, Codex app-server, ACP-stdio): spawn once, buffer stdout
 * into whole lines, write requests, and surface exit/error — so each transport is
 * a thin state machine over its own message shapes, not a re-implementation of
 * process plumbing.
 *
 * EPIPE-safe (a broken stdin pipe is swallowed) and flush-on-exit (a final
 * bufferless line is delivered), matching the one-shot primitive's robustness.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentSessionDeps } from './types.js';

export interface LineStdioHandlers {
  onLine: (line: string) => void;
  onStderr?: (text: string) => void;
  onExit: (code: number | null) => void;
  onError: (err: Error) => void;
}

export class LineStdioProcess {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly handlers: LineStdioHandlers,
    private readonly opts: { cwd?: string; env?: Record<string, string> } = {},
    private readonly deps: AgentSessionDeps = {},
  ) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start(): void {
    if (this.running) return;
    const spawnImpl = this.deps.spawnImpl ?? spawn;
    const child = spawnImpl(this.command, [...this.args], {
      cwd: this.opts.cwd || process.cwd(),
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdin.on('error', () => { /* broken pipe — the peer already has what it needs */ });
    child.stdout.on('data', (chunk: Buffer) => this.ingest(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => this.handlers.onStderr?.(chunk.toString('utf8')));
    child.once('error', (err) => this.handlers.onError(err instanceof Error ? err : new Error(String(err))));
    child.once('exit', (code) => { this.flush(); this.handlers.onExit(code); });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim()) this.handlers.onLine(line);
    }
  }

  private flush(): void {
    if (this.buffer.trim()) this.handlers.onLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
  }

  /** Write one message; a trailing newline is added when absent. */
  write(message: string): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(message.endsWith('\n') ? message : `${message}\n`, () => { /* EPIPE handled above */ });
    } catch { /* stream already closed */ }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    try { if (this.running) this.child!.kill(signal); } catch { /* already gone */ }
  }
}
