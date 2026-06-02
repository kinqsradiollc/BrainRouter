import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCliKnobs } from '../../config/config.js';

/**
 * Optional sandboxing for `run_command`.
 *
 * Activated by `cli.sandbox: 'on'` (config.json — no env var). When inactive,
 * commands run exactly as before (with the existing user confirmation prompt).
 * When active, the command is wrapped in the platform's native sandboxer:
 *
 *   - macOS: `sandbox-exec -f <profile>` with a generated `.sb` profile that
 *            denies network by default, restricts writes to the workspace, and
 *            allows reads of `/usr`, `/bin`, `/etc`, the workspace, and any
 *            extra paths in `cli.sandboxReadPaths`.
 *   - Linux: `bwrap` (bubblewrap) when available; falls back to `firejail`.
 *            Sets up a fresh mount namespace with the workspace mounted rw and
 *            the rest of the FS bind-mounted ro.
 *   - Windows / no sandboxer: there is no portable sandbox. Rather than
 *            SILENTLY running unsandboxed, `cli.sandboxUnavailable` decides:
 *            `'deny'` (default) / `'ask'` refuse to run; `'warn'` runs
 *            unsandboxed with a loud notice (CODEX-SANDBOX-FAILCLOSED).
 *
 * The sandbox is intentionally an *additional* layer on top of the existing
 * user-confirmation step — confirmation guards intent, sandboxing guards blast
 * radius if the user approves something they shouldn't have.
 */

/** What to do when sandboxing was requested but is unavailable on this host. */
export type SandboxUnavailableMode = 'ask' | 'deny' | 'warn';

export interface SandboxConfig {
  enabled: boolean;
  workspaceRoot: string;
  /** Extra read-only paths to allow. */
  readPaths: string[];
  /** Extra write-allowed paths beyond the workspace. */
  writePaths: string[];
  /** If true, allow outbound network. Off by default. */
  allowNetwork: boolean;
  /** CODEX-SANDBOX-FAILCLOSED — behavior when the sandboxer is missing. */
  unavailableMode: SandboxUnavailableMode;
}

/**
 * CODEX-SANDBOX-FAILCLOSED (0.4.7) — pure decision for the case where
 * `sandbox: 'on'` but no sandboxer is available. Returns whether the command
 * may still run and the notice to surface. The security property: never
 * SILENTLY run unsandboxed when sandboxing was requested.
 *
 * - `'warn'` → run unsandboxed, but loudly (pre-0.4.7 behavior, opt-in).
 * - `'deny'` → refuse to run (fail closed).
 * - `'ask'`  → requires approval; this execution layer can't prompt, so it
 *              fails closed here (a future interactive approval path can route
 *              it). Either way it never runs unsandboxed without sign-off.
 */
export function decideUnavailableSandbox(
  mode: SandboxUnavailableMode,
  platformLabel: string,
): { run: boolean; notice: string } {
  const base = `sandbox: 'on' but no sandbox tool is available on ${platformLabel}`;
  switch (mode) {
    case 'warn':
      return { run: true, notice: `${base} — command ran UNSANDBOXED (cli.sandboxUnavailable='warn').` };
    case 'ask':
      return { run: false, notice: `${base} — approval required and no approver in this context; refused (cli.sandboxUnavailable='ask').` };
    default:
      return { run: false, notice: `${base} — refused to run unsandboxed (cli.sandboxUnavailable='deny').` };
  }
}

/**
 * CODEX-SANDBOX-FAILCLOSED — recognise stderr that indicates the sandboxer
 * itself denied the run (vs. an ordinary command failure), so the agent can
 * report "blocked by sandbox" instead of misreading it as a normal error.
 * Pure + signature-based (bwrap / firejail / sandbox-exec / seccomp).
 */
export function detectSandboxDenial(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes('bwrap:') ||
    s.includes('sandbox-exec:') ||
    s.includes('operation not permitted') ||
    s.includes('permission denied') && s.includes('sandbox') ||
    s.includes('seccomp') ||
    s.includes('firejail:') ||
    s.includes('cannot create new namespace') ||
    s.includes('namespace creation failed')
  );
}

export function resolveSandboxConfig(
  workspaceRoot: string,
  persistedExtras?: { readPaths?: string[]; writePaths?: string[] },
): SandboxConfig {
  const knobs = getCliKnobs();
  const enabled = knobs.sandbox === 'on';
  const cfgReads = knobs.sandboxReadPaths;
  const cfgWrites = knobs.sandboxWritePaths;
  const readPaths = Array.from(new Set([...(persistedExtras?.readPaths ?? []), ...cfgReads]));
  const writePaths = Array.from(new Set([...(persistedExtras?.writePaths ?? []), ...cfgWrites]));
  const allowNetwork = knobs.sandboxNetwork;
  const unavailableMode = knobs.sandboxUnavailable;
  return { enabled, workspaceRoot, readPaths, writePaths, allowNetwork, unavailableMode };
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  sandboxTool?: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  notice?: string;
  /** CODEX-SANDBOX-FAILCLOSED — true when the command never ran (refused). */
  refused?: boolean;
  /** CODEX-SANDBOX-FAILCLOSED — true when stderr looks like a sandbox denial. */
  sandboxDenied?: boolean;
}

/**
 * Execute `command` (a shell string) with optional sandboxing. Returns a
 * normalized result. Always returns; never throws on non-zero exit.
 */
export async function runShell(command: string, config: SandboxConfig, timeoutMs = 120_000): Promise<SandboxRunResult> {
  // Always pin cwd to the workspace root so `run_command` never inherits a
  // drifted process.cwd() (and writes test files into ~/.brainrouter).
  const cwd = config.workspaceRoot;
  if (!config.enabled) {
    return execShell(command, undefined, cwd, timeoutMs, false, 'none');
  }

  if (process.platform === 'darwin') {
    const profilePath = writeMacSandboxProfile(config);
    const wrapped = ['sandbox-exec', '-f', profilePath, '/bin/sh', '-c', command];
    const r = await execShell(wrapped[0], wrapped.slice(1), cwd, timeoutMs, true, 'sandbox-exec');
    r.sandboxDenied = detectSandboxDenial(r.stderr);
    return r;
  }

  if (process.platform === 'linux') {
    if (await binaryAvailable('bwrap')) {
      const args = buildBwrapArgs(config, command);
      const r = await execShell('bwrap', args, cwd, timeoutMs, true, 'bwrap');
      r.sandboxDenied = detectSandboxDenial(r.stderr);
      return r;
    }
    if (await binaryAvailable('firejail')) {
      const args = buildFirejailArgs(config, command);
      const r = await execShell('firejail', args, cwd, timeoutMs, true, 'firejail');
      r.sandboxDenied = detectSandboxDenial(r.stderr);
      return r;
    }
    return handleUnavailableSandbox(config, command, cwd, timeoutMs, 'Linux (no bwrap/firejail)');
  }

  // Windows / other — no portable sandbox in stdlib.
  return handleUnavailableSandbox(config, command, cwd, timeoutMs, process.platform);
}

/**
 * CODEX-SANDBOX-FAILCLOSED — sandboxing was requested but no sandboxer exists.
 * Consult `cli.sandboxUnavailable`: `'warn'` runs unsandboxed (loudly); `'deny'`
 * / `'ask'` refuse to run, returning a non-zero, clearly-noticed result instead
 * of silently executing without the requested isolation.
 */
async function handleUnavailableSandbox(
  config: SandboxConfig,
  command: string,
  cwd: string,
  timeoutMs: number,
  platformLabel: string,
): Promise<SandboxRunResult> {
  const verdict = decideUnavailableSandbox(config.unavailableMode, platformLabel);
  if (!verdict.run) {
    return {
      stdout: '',
      stderr: verdict.notice,
      exitCode: 126, // "command found but could not be executed" — refused by policy
      sandboxed: false,
      sandboxTool: 'none',
      notice: verdict.notice,
      refused: true,
    };
  }
  const fallback = await execShell(command, undefined, cwd, timeoutMs, false, 'none');
  fallback.notice = verdict.notice;
  return fallback;
}

function execShell(
  cmd: string,
  args: string[] | undefined,
  cwd: string | undefined,
  timeoutMs: number,
  sandboxed: boolean,
  tool: SandboxRunResult['sandboxTool'],
): Promise<SandboxRunResult> {
  return new Promise((resolve) => {
    const useShell = !args; // when no args provided, run as a single shell string
    const child = useShell
      ? spawn(cmd, { cwd, shell: true })
      : spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, sandboxed, sandboxTool: tool });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 127, sandboxed, sandboxTool: tool });
    });
  });
}

function binaryAvailable(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('command', ['-v', name], { shell: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Generate a macOS sandbox-exec profile and write it to a temp file. The
 * profile starts from `(deny default)` and explicitly allows the syscalls a
 * normal build/test command needs.
 */
function writeMacSandboxProfile(config: SandboxConfig): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork process-exec)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)', // permissive on reads — sandboxing writes is the priority
    `(allow file-write* (subpath "${escapeSb(config.workspaceRoot)}"))`,
    '(allow file-write* (subpath "/tmp"))',
    `(allow file-write* (subpath "${escapeSb(os.tmpdir())}"))`,
  ];
  for (const p of config.writePaths) {
    lines.push(`(allow file-write* (subpath "${escapeSb(p)}"))`);
  }
  if (config.allowNetwork) {
    lines.push('(allow network*)');
  }
  const profile = lines.join('\n');
  const file = path.join(os.tmpdir(), `brainrouter-sandbox-${process.pid}.sb`);
  fs.writeFileSync(file, profile, 'utf8');
  return file;
}

function escapeSb(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildBwrapArgs(config: SandboxConfig, command: string): string[] {
  const args: string[] = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/bin', '/bin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', config.workspaceRoot, config.workspaceRoot,
    '--chdir', config.workspaceRoot,
  ];
  for (const p of config.readPaths) {
    args.push('--ro-bind', p, p);
  }
  for (const p of config.writePaths) {
    args.push('--bind', p, p);
  }
  if (!config.allowNetwork) {
    args.push('--unshare-net');
  }
  args.push('/bin/sh', '-c', command);
  return args;
}

function buildFirejailArgs(config: SandboxConfig, command: string): string[] {
  const args: string[] = [
    '--quiet',
    `--whitelist=${config.workspaceRoot}`,
    `--read-only=/usr`,
    `--read-only=/etc`,
  ];
  for (const p of config.readPaths) args.push(`--read-only=${p}`);
  for (const p of config.writePaths) args.push(`--whitelist=${p}`);
  if (!config.allowNetwork) args.push('--net=none');
  args.push('/bin/sh', '-c', command);
  return args;
}
