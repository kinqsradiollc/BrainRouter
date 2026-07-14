import { spawnSync } from 'node:child_process';

export type ExecutionHost =
  | { id: string; kind: 'local'; platform?: NodeJS.Platform }
  | { id: string; kind: 'ssh'; target: string }
  | { id: string; kind: 'wsl'; distro?: string };

export interface HostCommandPlan { executable: string; args: string[]; cwd?: string }
export interface HostCommandResult { ok: boolean; stdout: string; stderr: string; status?: number }

function quotePosix(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

export function isSafeSshTarget(target: string): boolean {
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(target) && !target.startsWith('-');
}

export function planHostCommand(host: ExecutionHost, command: string, args: string[], cwd: string): HostCommandPlan {
  if (!command || command.startsWith('-') || /[\0\r\n]/.test(command)) throw new Error('Unsafe execution command.');
  if (host.kind === 'local') return { executable: command, args: [...args], cwd };
  if (host.kind === 'wsl') {
    const prefix = host.distro ? ['-d', host.distro] : [];
    return { executable: 'wsl.exe', args: [...prefix, '--cd', cwd, '--', command, ...args] };
  }
  if (!isSafeSshTarget(host.target)) throw new Error('Unsafe SSH target.');
  const remote = `cd ${quotePosix(cwd)} && exec ${[command, ...args].map(quotePosix).join(' ')}`;
  return { executable: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', host.target, 'sh', '-lc', remote] };
}

export function runOnHost(host: ExecutionHost, command: string, args: string[], cwd: string, timeout = 45_000): HostCommandResult {
  const plan = planHostCommand(host, command, args, cwd);
  const result = spawnSync(plan.executable, plan.args, {
    cwd: plan.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '', status: result.status ?? undefined };
}
