import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeTerminalGeometry,
  normalizeTerminalReuseKey,
} from '@kinqs/brainrouter-core/terminal';

export interface PtyLike {
  readonly pid: number;
  readonly process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export type PtySpawnOptions = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty?: boolean;
};

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

export type PtyOpenOptions = {
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  reuseKey?: string;
  cwd?: string;
};

export type PtyAdoptOptions = {
  shell: string;
  reuseKey?: string;
};

export type PtyOpenResult = {
  id: string;
  shell: string;
  pid: number;
  reused: boolean;
  snapshot: string;
  start: number;
  next: number;
  alive: boolean;
};

type PtySession = {
  id: string;
  pty: PtyLike;
  shell: string;
  reuseKey?: string;
  buffer: string;
  start: number;
  next: number;
  alive: boolean;
  subscriptions: Array<{ dispose(): void }>;
};

const DEFAULT_BUFFER_LIMIT = 400_000;
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function defaultPtySpawn(file: string, args: string[], options: PtySpawnOptions): PtyLike {
  // Keep the ABI-specific native module off the Node-based test path. Electron
  // loads it only when a real terminal is opened, after electron-builder has
  // rebuilt it for the packaged runtime.
  const require = createRequire(import.meta.url);
  ensureSpawnHelperExecutable(require.resolve('node-pty'));
  const nodePty = require('node-pty') as { spawn: PtySpawn };
  return nodePty.spawn(file, args, options);
}

/**
 * node-pty's macOS prebuild delegates process creation to spawn-helper. Some
 * package caches restore that binary without its executable bit, which makes
 * every valid shell fail with the opaque "posix_spawnp failed" error.
 */
export function ensureSpawnHelperExecutable(nodePtyEntry: string): void {
  if (process.platform === 'win32') return;
  const packageRoot = path.resolve(path.dirname(nodePtyEntry), '..');
  const candidates = [
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  for (const helper of candidates) {
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755);
    return;
  }
}

export class PtyRegistry {
  private readonly sessions = new Map<string, PtySession>();
  private readonly reusable = new Map<string, string>();
  private readonly workspaceRoot: string;
  private readonly bufferLimit: number;
  private readonly spawn: PtySpawn;
  private sequence = 0;

  constructor(options: { workspaceRoot: string; bufferLimit?: number; spawn?: PtySpawn }) {
    this.workspaceRoot = options.workspaceRoot;
    this.bufferLimit = Math.max(1, Math.floor(options.bufferLimit ?? DEFAULT_BUFFER_LIMIT));
    this.spawn = options.spawn ?? defaultPtySpawn;
  }

  get size(): number { return this.sessions.size; }

  list(): Array<{ id: string; shell: string; pid: number; start: number; next: number; alive: boolean }> {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      shell: session.shell,
      pid: session.pty.pid,
      start: session.start,
      next: session.next,
      alive: session.alive,
    }));
  }

  open(options: PtyOpenOptions): PtyOpenResult {
    const { cols, rows } = normalizeTerminalGeometry(options.cols, options.rows);
    const reuseKey = normalizeTerminalReuseKey(options.reuseKey);
    const existingId = reuseKey ? this.reusable.get(reuseKey) : undefined;
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing?.alive) {
      try { existing.pty.resize(cols, rows); } catch { /* renderer can retry */ }
      return this.result(existing, true);
    }
    if (existingId) this.remove(existingId, true);

    const isWindows = process.platform === 'win32';
    const shell = options.shell || (isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh'));
    const args = options.args ?? (isWindows ? ['-NoLogo'] : ['-i']);
    const env = { ...cleanEnv(process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' };
    const pty = this.spawn(shell, args, {
      name: 'xterm-256color', cols, rows, cwd: options.cwd || this.workspaceRoot, env,
      ...(isWindows ? { useConpty: true } : {}),
    });
    return this.adopt(pty, { shell, reuseKey });
  }

  /** Register a PTY-like transport that was opened outside node-pty (for
   * example an SSH2 channel). It gets the same bounded scrollback, reattach,
   * resize, input, and workspace-shutdown lifecycle as a local PTY. */
  adopt(pty: PtyLike, options: PtyAdoptOptions): PtyOpenResult {
    const reuseKey = normalizeTerminalReuseKey(options.reuseKey);
    const existingId = reuseKey ? this.reusable.get(reuseKey) : undefined;
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing?.alive) {
      try { pty.kill(); } catch { /* duplicate transport is already obsolete */ }
      return this.result(existing, true);
    }
    if (existingId) this.remove(existingId, true);
    const id = `t${++this.sequence}`;
    const session: PtySession = {
      id, pty, shell: options.shell, reuseKey, buffer: '', start: 0, next: 0, alive: true, subscriptions: [],
    };
    session.subscriptions.push(pty.onData((data) => this.append(session, data)));
    session.subscriptions.push(pty.onExit(({ exitCode }) => {
      if (!session.alive) return;
      session.alive = false;
      this.append(session, `\r\n[shell exited ${Number.isFinite(exitCode) ? exitCode : '?'}]\r\n`);
    }));
    this.sessions.set(id, session);
    if (reuseKey) this.reusable.set(reuseKey, id);
    return this.result(session, false);
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.alive) return false;
    try { session.pty.write(data); return true; } catch { session.alive = false; return false; }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session?.alive) return false;
    try {
      const geometry = normalizeTerminalGeometry(cols, rows);
      session.pty.resize(geometry.cols, geometry.rows);
      return true;
    } catch { return false; }
  }

  read(id: string, from: number): { chunk: string; next: number; alive: boolean; dropped: number } {
    const session = this.sessions.get(id);
    if (!session) return { chunk: '', next: 0, alive: false, dropped: 0 };
    const requested = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    const cursor = Math.max(session.start, Math.min(requested, session.next));
    return {
      chunk: session.buffer.slice(cursor - session.start),
      next: session.next,
      alive: session.alive,
      dropped: Math.max(0, session.start - requested),
    };
  }

  snapshot(id: string): PtyOpenResult | undefined {
    const session = this.sessions.get(id);
    return session ? this.result(session, true) : undefined;
  }

  kill(id: string): boolean { return this.remove(id, true); }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id, true);
  }

  private result(session: PtySession, reused: boolean): PtyOpenResult {
    return {
      id: session.id, shell: session.shell, pid: session.pty.pid, reused,
      snapshot: session.buffer, start: session.start, next: session.next, alive: session.alive,
    };
  }

  private append(session: PtySession, data: string): void {
    if (!data) return;
    session.buffer += data;
    session.next += data.length;
    if (session.buffer.length > this.bufferLimit) {
      const removed = session.buffer.length - this.bufferLimit;
      session.buffer = session.buffer.slice(removed);
      session.start += removed;
    }
  }

  private remove(id: string, kill: boolean): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.alive = false;
    if (kill) { try { session.pty.kill(); } catch { /* already exited */ } }
    for (const subscription of session.subscriptions) subscription.dispose();
    this.sessions.delete(id);
    if (session.reuseKey && this.reusable.get(session.reuseKey) === id) this.reusable.delete(session.reuseKey);
    return true;
  }
}
