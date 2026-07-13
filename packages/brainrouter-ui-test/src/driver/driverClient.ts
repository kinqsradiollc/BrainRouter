/**
 * The host-side client that owns one headed Playwright driver child and exposes
 * it as a `Backend`. It spawns the driver (Node script), waits for its `ready`
 * handshake, then writes `{reqId, cmd}` lines and resolves each `perform` against
 * the matching `{reqId, result}` reply. One client = one browser; the Desktop
 * panel and the agent share the same instance so they drive the same browser.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeLine, LineDecoder, type DriverReply } from './protocol.js';
import type { Backend } from '../command/backend.js';
import type { Command } from '../types.js';

export interface DriverClientOptions {
  /** Node script to run as the driver (default: the bundled playwrightDriver.js). */
  scriptPath?: string;
  /** Node executable (default: the current process's). */
  nodePath?: string;
  /** Base dev-server URL under test. */
  baseUrl?: string;
  /** Workspace root (driver cwd + artifact output). */
  cwd?: string;
  /** Launch headed (default true). */
  headed?: boolean;
  /** Per-command timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Startup (browser launch) timeout in ms (default 30000). */
  startTimeoutMs?: number;
  /** Extra environment for the driver. */
  env?: Record<string, string>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const READY = 'ready';

export class DriverClient implements Backend {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail = '';

  constructor(private readonly opts: DriverClientOptions = {}) {}

  private scriptPath(): string {
    return this.opts.scriptPath ?? fileURLToPath(new URL('./playwrightDriver.js', import.meta.url));
  }

  /** Spawn the driver and await its ready handshake (idempotent). */
  start(): Promise<void> {
    if (this.child && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const node = this.opts.nodePath ?? process.execPath;
      let child: ChildProcess;
      try {
        child = spawn(node, [this.scriptPath()], {
          cwd: this.opts.cwd,
          env: {
            ...process.env,
            ...this.opts.env,
            UITEST_BASE_URL: this.opts.baseUrl ?? '',
            UITEST_HEADED: (this.opts.headed ?? true) ? '1' : '0',
            UITEST_CWD: this.opts.cwd ?? process.cwd(),
            UITEST_TIMEOUT_MS: String(this.opts.timeoutMs ?? 30000),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2000);
      });
      child.on('exit', (code) => this.onExit(code));
      child.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));

      this.pending.set(READY, {
        resolve: () => resolve(),
        reject,
        timer: setTimeout(
          () => this.settle(READY, new Error(`driver start timed out${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`)),
          this.opts.startTimeoutMs ?? 30000,
        ),
      });
    });

    // Clear the "starting" latch once settled (success or failure).
    void this.starting.then(
      () => {
        this.starting = null;
      },
      () => {
        this.starting = null;
      },
    );
    return this.starting;
  }

  private onStdout(chunk: string): void {
    for (const msg of this.decoder.push(chunk)) {
      const reply = msg as DriverReply;
      if (!reply || typeof reply.reqId !== 'string') continue;
      this.settle(reply.reqId, reply.error ? new Error(reply.error) : undefined, reply.result);
    }
  }

  private settle(reqId: string, err?: Error, result?: unknown): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    if (err) p.reject(err);
    else p.resolve(result);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onExit(code: number | null): void {
    this.failAll(new Error(`driver exited (code ${code ?? 'null'})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`));
    this.child = null;
    this.starting = null;
  }

  async perform(cmd: Command): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new Error('driver not running');
    const reqId = `r${++this.seq}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve,
        reject,
        timer: setTimeout(() => this.settle(reqId, new Error(`command timed out: ${cmd.kind}`)), this.opts.timeoutMs ?? 30000),
      });
      child.stdin!.write(encodeLine({ reqId, cmd }));
    });
  }

  /** Ask the driver to shut down, then ensure the child is gone. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin?.write(encodeLine({ reqId: `r${++this.seq}`, cmd: { kind: 'shutdown' } }));
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.child = null;
    this.starting = null;
  }
}
