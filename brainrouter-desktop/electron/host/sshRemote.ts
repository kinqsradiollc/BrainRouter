import fs from 'node:fs';
import path from 'node:path';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client, type ClientChannel } from 'ssh2';
import { getWorkspaceStateRoot } from '@kinqs/brainrouter-core/storage';
import { isSafeRef } from '@kinqs/brainrouter-core/git';
import type { PtyLike } from './pty.js';

const MAX_OUTPUT = 16_000_000;
const DEFAULT_TIMEOUT = 45_000;

export interface SshHostConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  workspaceRoot: string;
  hostKeySha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface SshHostInput {
  id?: string;
  label?: string;
  host: string;
  port?: number;
  username: string;
  workspaceRoot: string;
  hostKeySha256: string;
}

export interface RemoteCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status?: number;
}

export interface RemoteWorktreeCapture {
  changedFiles: number;
  patchPath?: string;
  preview: string;
}

export interface RemoteWorktreeRemoval {
  ok: boolean;
  notice?: string;
  recoveryRef?: string;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'candidate';
}

export function sshHostKeyFingerprint(key: Buffer | string): string {
  const raw = Buffer.isBuffer(key) ? key : Buffer.from(key, 'binary');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

export function buildRemoteCommand(command: string, args: string[], cwd: string): string {
  if (!command || command.startsWith('-') || /[\0\r\n]/.test(command)) throw new Error('Unsafe remote command.');
  if (!posix.isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) throw new Error('Remote working directory must be an absolute POSIX path.');
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error('Remote command arguments cannot contain control lines.');
  return `cd ${quotePosix(cwd)} && exec ${[command, ...args].map(quotePosix).join(' ')}`;
}

function validateHostInput(input: SshHostInput): Omit<SshHostConfig, 'createdAt' | 'updatedAt'> {
  const host = input.host.trim();
  const username = input.username.trim();
  const workspaceRoot = input.workspaceRoot.trim().replace(/\/+$/, '') || '/';
  const hostKeySha256 = input.hostKeySha256.trim();
  const port = Math.floor(input.port ?? 22);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(host) || host.startsWith('-')) throw new Error('SSH host is invalid.');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username) || username.startsWith('-')) throw new Error('SSH username is invalid.');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('SSH port must be between 1 and 65535.');
  if (!posix.isAbsolute(workspaceRoot) || /[\0\r\n]/.test(workspaceRoot) || workspaceRoot.length > 2_048) throw new Error('Remote workspace must be an absolute POSIX path.');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeySha256)) throw new Error('A pinned SHA-256 SSH host-key fingerprint is required.');
  const key = `${username}@${host}:${port}:${workspaceRoot}`;
  const id = input.id?.trim() || `ssh_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  if (!/^ssh_[a-zA-Z0-9_-]{4,80}$/.test(id)) throw new Error('SSH host id is invalid.');
  const label = (input.label?.trim() || `${username}@${host}`).slice(0, 80);
  return { id, label, host, port, username, workspaceRoot, hostKeySha256 };
}

export class SshHostRegistry {
  private readonly file: string;

  constructor(workspaceRoot: string) {
    this.file = path.join(getWorkspaceStateRoot(workspaceRoot), 'sshHosts.json');
  }

  list(): SshHostConfig[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: number; hosts?: unknown[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return [];
      return parsed.hosts.flatMap((row) => {
        try {
          const raw = row as SshHostConfig;
          const valid = validateHostInput(raw);
          return [{ ...valid, createdAt: raw.createdAt, updatedAt: raw.updatedAt }];
        } catch { return []; }
      });
    } catch { return []; }
  }

  get(id: string): SshHostConfig | undefined { return this.list().find((host) => host.id === id); }

  put(input: SshHostInput): SshHostConfig {
    const valid = validateHostInput(input);
    const now = new Date().toISOString();
    const hosts = this.list();
    const prior = hosts.find((host) => host.id === valid.id);
    const next: SshHostConfig = { ...valid, createdAt: prior?.createdAt ?? now, updatedAt: now };
    const rows = [...hosts.filter((host) => host.id !== next.id), next].slice(-24);
    this.write(rows);
    return next;
  }

  remove(id: string): boolean {
    const hosts = this.list();
    const rows = hosts.filter((host) => host.id !== id);
    if (rows.length === hosts.length) return false;
    this.write(rows);
    return true;
  }

  private write(hosts: SshHostConfig[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows has no POSIX modes */ }
  }
}

class SshPty implements PtyLike {
  readonly pid = 0;
  readonly process: string;
  private readonly dataListeners = new Set<(value: string) => void>();
  private readonly exitListeners = new Set<(value: { exitCode: number }) => void>();
  private ended = false;
  private exitCode = 0;
  private pendingData = '';

  constructor(private readonly client: Client, private readonly channel: ClientChannel, processName: string) {
    this.process = processName;
    channel.on('data', (value: Buffer | string) => this.emitData(value));
    channel.stderr.on('data', (value: Buffer | string) => this.emitData(value));
    channel.once('close', (code?: number) => this.finish(Number.isFinite(code) ? Number(code) : 0));
    channel.once('error', (error: Error) => { this.emitData(`\r\n[SSH channel error: ${error.message}]\r\n`); this.finish(1); });
    client.once('error', (error: Error) => { this.emitData(`\r\n[SSH connection error: ${error.message}]\r\n`); this.finish(1); });
  }

  write(data: string): void { if (!this.ended) this.channel.write(data); }
  resize(cols: number, rows: number): void { if (!this.ended) this.channel.setWindow(rows, cols, 0, 0); }
  kill(signal = 'TERM'): void {
    if (this.ended) return;
    try { this.channel.signal(signal.replace(/^SIG/, '')); } catch { /* channel may already be closing */ }
    try { this.channel.close(); } catch { /* already closed */ }
    this.finish(143);
  }
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    if (this.pendingData) {
      const pending = this.pendingData;
      this.pendingData = '';
      listener(pending);
    }
    return { dispose: () => { this.dataListeners.delete(listener); } };
  }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    if (this.ended) queueMicrotask(() => listener({ exitCode: this.exitCode }));
    return { dispose: () => { this.exitListeners.delete(listener); } };
  }
  private emitData(value: Buffer | string): void {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (!this.dataListeners.size) this.pendingData = `${this.pendingData}${text}`.slice(-64_000);
    else for (const listener of this.dataListeners) listener(text);
  }
  private finish(exitCode: number): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = exitCode;
    for (const listener of this.exitListeners) listener({ exitCode });
    this.client.end();
  }
}

export class SshTransport {
  constructor(private readonly createClient: () => Client = () => new Client()) {}

  async discoverHostKey(input: Pick<SshHostInput, 'host' | 'port' | 'username'>): Promise<string> {
    const host = input.host.trim();
    const username = input.username.trim();
    const port = Math.floor(input.port ?? 22);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(host) || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('SSH host or username is invalid.');
    return await new Promise<string>((resolve, reject) => {
      const client = this.createClient();
      let fingerprint = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        client.end();
        if (fingerprint) resolve(fingerprint);
        else reject(error ?? new Error('The SSH server did not present a host key.'));
      };
      const timer = setTimeout(() => finish(new Error('SSH host-key discovery timed out.')), 10_000);
      timer.unref?.();
      client.once('error', (error) => { clearTimeout(timer); finish(error); });
      client.once('close', () => { clearTimeout(timer); finish(); });
      client.connect({
        host, port, username, readyTimeout: 8_000,
        // Deliberately reject after reading the key. No SSH agent is supplied,
        // so discovery cannot authenticate or sign anything for an untrusted host.
        hostVerifier: (key: Buffer) => { fingerprint = sshHostKeyFingerprint(key); return false; },
      });
    });
  }

  async exec(host: SshHostConfig, command: string, args: string[], cwd: string, timeout = DEFAULT_TIMEOUT): Promise<RemoteCommandResult> {
    const client = await this.connect(host);
    const remote = buildRemoteCommand(command, args, cwd);
    return await new Promise<RemoteCommandResult>((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const finish = (status?: number, error?: Error): void => {
        if (settled) return;
        settled = true;
        client.end();
        resolve({ ok: status === 0 && !error, stdout, stderr: error ? `${stderr}${stderr ? '\n' : ''}${error.message}` : stderr, status });
      };
      const timer = setTimeout(() => finish(undefined, new Error('Remote command timed out.')), Math.max(1, timeout));
      timer.unref?.();
      client.exec(remote, { env: { GIT_TERMINAL_PROMPT: '0' } }, (error, channel) => {
        if (error) { clearTimeout(timer); finish(undefined, error); return; }
        const append = (kind: 'stdout' | 'stderr', value: Buffer | string): void => {
          const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
          if (stdout.length + stderr.length + text.length > MAX_OUTPUT) {
            clearTimeout(timer); channel.close(); finish(undefined, new Error('Remote command output exceeded the safety limit.')); return;
          }
          if (kind === 'stdout') stdout += text; else stderr += text;
        };
        channel.on('data', (value: Buffer | string) => append('stdout', value));
        channel.stderr.on('data', (value: Buffer | string) => append('stderr', value));
        channel.once('close', (code?: number) => { clearTimeout(timer); finish(Number.isFinite(code) ? Number(code) : 0); });
        channel.once('error', (channelError: Error) => { clearTimeout(timer); finish(undefined, channelError); });
      });
    });
  }

  async openPty(host: SshHostConfig, command: string, args: string[], cwd: string, cols = 80, rows = 24): Promise<PtyLike> {
    const client = await this.connect(host);
    const remote = buildRemoteCommand(command, args, cwd);
    return await new Promise<PtyLike>((resolve, reject) => {
      client.exec(remote, { pty: { term: 'xterm-256color', cols, rows } }, (error, channel) => {
        if (error) { client.end(); reject(error); return; }
        resolve(new SshPty(client, channel, `${host.username}@${host.host}:${command}`));
      });
    });
  }

  private async connect(host: SshHostConfig): Promise<Client> {
    const checked = validateHostInput(host);
    const agent = process.env.SSH_AUTH_SOCK?.trim() || (process.platform === 'win32' ? 'pageant' : '');
    if (!agent) throw new Error('SSH agent is unavailable. Start ssh-agent and load the remote host key first.');
    return await new Promise<Client>((resolve, reject) => {
      const client = this.createClient();
      let settled = false;
      const fail = (error: Error): void => { if (!settled) { settled = true; client.end(); reject(error); } };
      client.once('ready', () => { if (!settled) { settled = true; resolve(client); } });
      client.once('error', fail);
      client.connect({
        host: checked.host, port: checked.port, username: checked.username, agent,
        readyTimeout: 12_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => sshHostKeyFingerprint(key) === checked.hostKeySha256,
      });
    });
  }
}

export class RemoteWorktreeManager {
  readonly registry: SshHostRegistry;

  constructor(private readonly workspaceRoot: string, readonly transport = new SshTransport()) {
    this.registry = new SshHostRegistry(workspaceRoot);
  }

  async test(hostId: string): Promise<{ ok: boolean; gitVersion?: string; adapters?: string[]; error?: string }> {
    const host = this.requireHost(hostId);
    const [result, adapters] = await Promise.all([
      this.transport.exec(host, 'git', ['--version'], host.workspaceRoot, 15_000),
      this.transport.exec(host, 'sh', ['-lc', 'for c in brainrouter claude codex opencode gemini; do command -v "$c" >/dev/null 2>&1 && printf "%s\\n" "$c"; done'], host.workspaceRoot, 15_000),
    ]);
    return result.ok
      ? { ok: true, gitVersion: result.stdout.trim(), adapters: adapters.ok ? adapters.stdout.split(/\r?\n/).filter(Boolean) : [] }
      : { ok: false, error: result.stderr.trim() || 'Remote Git probe failed.' };
  }

  async create(hostId: string, candidateId: string, baseRef: string): Promise<{ worktreeRoot: string; baseOid: string }> {
    const host = this.requireHost(hostId);
    if (!isSafeRef(baseRef)) throw new Error('Remote fan-out base ref is unsafe.');
    const localOid = execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: this.workspaceRoot, encoding: 'utf8', timeout: 10_000 }).trim();
    const remoteOid = await this.transport.exec(host, 'git', ['rev-parse', '--verify', `${baseRef}^{commit}`], host.workspaceRoot);
    if (!remoteOid.ok || remoteOid.stdout.trim() !== localOid) throw new Error('Remote checkout is not at the same base commit as this workspace. Fetch or update it before launching.');
    const base = posix.join(posix.dirname(host.workspaceRoot), '.brainrouter-worktrees');
    const worktreeRoot = posix.join(base, `${safeSegment(posix.basename(host.workspaceRoot))}-${safeSegment(candidateId)}`);
    const made = await this.transport.exec(host, 'mkdir', ['-p', base], '/');
    if (!made.ok) throw new Error(made.stderr.trim() || 'Could not create the remote worktree directory.');
    const created = await this.transport.exec(host, 'git', ['worktree', 'add', '--detach', worktreeRoot, localOid], host.workspaceRoot);
    if (!created.ok) throw new Error(created.stderr.trim() || 'Could not create the remote worktree.');
    return { worktreeRoot, baseOid: localOid };
  }

  async inspect(hostId: string, worktreeRoot: string, baseOid?: string): Promise<{ changedFiles: number; summary: string }> {
    const host = this.requireHost(hostId);
    const base = baseOid && /^[a-f0-9]{40,64}$/i.test(baseOid) ? baseOid : 'HEAD';
    const status = await this.transport.exec(host, 'git', ['status', '--short'], worktreeRoot, 8_000);
    const [names, stat] = await Promise.all([
      this.transport.exec(host, 'git', ['diff', '--name-only', base], worktreeRoot, 8_000),
      this.transport.exec(host, 'git', ['diff', '--stat', base], worktreeRoot, 8_000),
    ]);
    const changed = new Set(names.ok ? names.stdout.split(/\r?\n/).filter(Boolean) : []);
    if (status.ok) for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) changed.add(line.slice(3).trim());
    return {
      changedFiles: changed.size,
      summary: `${status.stdout}${stat.stdout ? `\n${stat.stdout}` : ''}`.slice(0, 8_000),
    };
  }

  async capture(hostId: string, candidateId: string, worktreeRoot: string, patchFile: string, baseOid?: string): Promise<RemoteWorktreeCapture> {
    const host = this.requireHost(hostId);
    const base = baseOid && /^[a-f0-9]{40,64}$/i.test(baseOid) ? baseOid : 'HEAD';
    const staged = await this.transport.exec(host, 'git', ['add', '-A'], worktreeRoot);
    if (!staged.ok) return { changedFiles: 0, preview: staged.stderr.trim() };
    const names = await this.transport.exec(host, 'git', ['diff', '--cached', '--name-only', base], worktreeRoot);
    const changedFiles = names.ok ? names.stdout.split(/\r?\n/).filter(Boolean).length : 0;
    if (!changedFiles) return { changedFiles: 0, preview: '' };
    const [binary, preview] = await Promise.all([
      this.transport.exec(host, 'git', ['diff', '--cached', '--binary', base], worktreeRoot),
      this.transport.exec(host, 'git', ['diff', '--cached', base], worktreeRoot),
    ]);
    if (!binary.ok || !binary.stdout.trim()) return { changedFiles: 0, preview: binary.stderr.trim() };
    fs.mkdirSync(path.dirname(patchFile), { recursive: true });
    fs.writeFileSync(patchFile, binary.stdout, { encoding: 'utf8', mode: 0o600 });
    return { changedFiles, patchPath: patchFile, preview: (preview.ok ? preview.stdout : names.stdout).slice(0, 16_000) };
  }

  async remove(hostId: string, candidateId: string, worktreeRoot: string, baseOid: string): Promise<RemoteWorktreeRemoval> {
    const host = this.requireHost(hostId);
    const head = await this.transport.exec(host, 'git', ['rev-parse', '--verify', 'HEAD'], worktreeRoot);
    let recoveryRef: string | undefined;
    if (head.ok && /^[a-f0-9]{40,64}$/i.test(head.stdout.trim()) && head.stdout.trim() !== baseOid) {
      recoveryRef = `refs/brainrouter/recovery/${safeSegment(candidateId)}`;
      const zero = '0'.repeat(head.stdout.trim().length);
      const pinned = await this.transport.exec(host, 'git', ['update-ref', recoveryRef, head.stdout.trim(), zero], host.workspaceRoot);
      if (!pinned.ok) return { ok: false, notice: pinned.stderr.trim() || 'Remote committed work could not be pinned to a recovery ref.' };
    }
    const removed = await this.transport.exec(host, 'git', ['worktree', 'remove', '--force', worktreeRoot], host.workspaceRoot);
    return removed.ok
      ? { ok: true, ...(recoveryRef ? { recoveryRef } : {}) }
      : { ok: false, notice: removed.stderr.trim() || 'Remote worktree removal failed; the checkout was retained.', ...(recoveryRef ? { recoveryRef } : {}) };
  }

  requireHost(id: string): SshHostConfig {
    const host = this.registry.get(id);
    if (!host) throw new Error('Remote execution host is not configured.');
    return host;
  }
}
