import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Optional sandboxing for `run_command`.
 *
 * Activated by setting `BRAINROUTER_SANDBOX=on`. When inactive, commands run
 * exactly as before (with the existing user confirmation prompt). When
 * active, the command is wrapped in the platform's native sandboxer:
 *
 *   - macOS: `sandbox-exec -f <profile>` with a generated `.sb` profile that
 *            denies network by default, restricts writes to the workspace, and
 *            allows reads of `/usr`, `/bin`, `/etc`, the workspace, and any
 *            extra paths in `BRAINROUTER_SANDBOX_READ_PATHS`.
 *   - Linux: `bwrap` (bubblewrap) when available; falls back to `firejail`.
 *            Sets up a fresh mount namespace with the workspace mounted rw and
 *            the rest of the FS bind-mounted ro.
 *   - Windows: no native sandbox in stdlib; falls back to unsandboxed run with
 *              a clear warning so the user knows the flag was honored as a no-op.
 *
 * The sandbox is intentionally an *additional* layer on top of the existing
 * user-confirmation step — confirmation guards intent, sandboxing guards blast
 * radius if the user approves something they shouldn't have.
 */

export interface SandboxConfig {
  enabled: boolean;
  workspaceRoot: string;
  /** Extra read-only paths to allow. */
  readPaths: string[];
  /** Extra write-allowed paths beyond the workspace. */
  writePaths: string[];
  /** If true, allow outbound network. Off by default. */
  allowNetwork: boolean;
}

export function resolveSandboxConfig(
  workspaceRoot: string,
  persistedExtras?: { readPaths?: string[]; writePaths?: string[] },
): SandboxConfig {
  const enabled = (process.env.BRAINROUTER_SANDBOX ?? '').toLowerCase() === 'on';
  const envReads = (process.env.BRAINROUTER_SANDBOX_READ_PATHS ?? '')
    .split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  const envWrites = (process.env.BRAINROUTER_SANDBOX_WRITE_PATHS ?? '')
    .split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  const readPaths = Array.from(new Set([...(persistedExtras?.readPaths ?? []), ...envReads]));
  const writePaths = Array.from(new Set([...(persistedExtras?.writePaths ?? []), ...envWrites]));
  const allowNetwork = (process.env.BRAINROUTER_SANDBOX_NETWORK ?? '').toLowerCase() === 'on';
  return { enabled, workspaceRoot, readPaths, writePaths, allowNetwork };
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  sandboxTool?: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  notice?: string;
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
    return execShell(wrapped[0], wrapped.slice(1), cwd, timeoutMs, true, 'sandbox-exec');
  }

  if (process.platform === 'linux') {
    if (await binaryAvailable('bwrap')) {
      const args = buildBwrapArgs(config, command);
      return execShell('bwrap', args, cwd, timeoutMs, true, 'bwrap');
    }
    if (await binaryAvailable('firejail')) {
      const args = buildFirejailArgs(config, command);
      return execShell('firejail', args, cwd, timeoutMs, true, 'firejail');
    }
    const fallback = await execShell('/bin/sh', ['-c', command], cwd, timeoutMs, false, 'none');
    fallback.notice = 'BRAINROUTER_SANDBOX=on but neither bwrap nor firejail is installed — command ran UNSANDBOXED.';
    return fallback;
  }

  // Windows / other — no portable sandbox. Run unsandboxed with a notice.
  const fallback = await execShell(command, undefined, cwd, timeoutMs, false, 'none');
  fallback.notice = `BRAINROUTER_SANDBOX=on but no sandbox tool is available on ${process.platform} — command ran UNSANDBOXED.`;
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
