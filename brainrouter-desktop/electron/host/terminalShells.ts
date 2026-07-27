/**
 * Host-owned native terminal shell discovery.
 *
 * The renderer selects stable IDs only. Executable paths and startup arguments
 * stay inside Electron so a compromised renderer cannot turn the shell picker
 * into an arbitrary-process launcher.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface TerminalShell {
  id: string;
  label: string;
  description: string;
  shell: string;
  args: string[];
  isDefault: boolean;
}

interface TerminalShellDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

/** Return the installed native shells in deterministic display order. */
export function discoverTerminalShells(
  options: TerminalShellDiscoveryOptions = {},
): { shells: TerminalShell[]; defaultId: string } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const candidates = platform === 'win32'
    ? windowsShellCandidates(env, exists)
    : posixShellCandidates(env, exists);
  const first = candidates[0] ?? fallbackShell(platform, env);
  const shells = candidates.length > 0 ? candidates : [first];
  return {
    shells: shells.map((shell, index) => ({ ...shell, isDefault: index === 0 })),
    defaultId: first.id,
  };
}

/** Resolve an untrusted renderer ID to one of the host-discovered shells. */
export function resolveTerminalShell(
  id: unknown,
  options: TerminalShellDiscoveryOptions = {},
): TerminalShell {
  const catalog = discoverTerminalShells(options);
  return catalog.shells.find((shell) => shell.id === id) ?? catalog.shells[0]!;
}

function posixShellCandidates(
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): TerminalShell[] {
  const configured = absoluteExisting(env.SHELL, exists);
  const known = [
    shellCandidate('zsh', 'Z shell', '/bin/zsh', ['-i'], exists),
    shellCandidate('bash', 'Bash', '/bin/bash', ['-i'], exists),
    shellCandidate('fish', 'Fish', firstExisting([
      '/opt/homebrew/bin/fish',
      '/usr/local/bin/fish',
      '/opt/local/bin/fish',
      '/usr/bin/fish',
    ], exists), ['-i'], exists),
    shellCandidate('sh', 'POSIX shell', '/bin/sh', ['-i'], exists),
  ].filter((candidate): candidate is TerminalShell => candidate !== null);
  if (!configured) return known;
  const configuredIndex = known.findIndex((candidate) => candidate.shell === configured);
  if (configuredIndex >= 0) {
    return [known[configuredIndex]!, ...known.filter((_, index) => index !== configuredIndex)];
  }
  return [{
    id: 'default',
    label: `Default shell (${path.basename(configured)})`,
    description: 'Shell configured by the operating system.',
    shell: configured,
    args: ['-i'],
    isDefault: false,
  }, ...known];
}

function windowsShellCandidates(
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): TerminalShell[] {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const cmd = firstExisting([
    env.ComSpec,
    path.win32.join(systemRoot, 'System32', 'cmd.exe'),
    findOnPath('cmd.exe', env, exists),
  ], exists);
  const powershell = firstExisting([
    findOnPath('pwsh.exe', env, exists),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    findOnPath('powershell.exe', env, exists),
  ], exists);
  const gitBash = firstExisting([
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    findOnPath('bash.exe', env, exists),
  ], exists);
  const wsl = firstExisting([
    path.win32.join(systemRoot, 'System32', 'wsl.exe'),
    findOnPath('wsl.exe', env, exists),
  ], exists);
  return [
    shellCandidate('cmd', 'Command Prompt', cmd, [], exists),
    shellCandidate('powershell', 'PowerShell', powershell, ['-NoLogo'], exists),
    shellCandidate('git-bash', 'Git Bash', gitBash, ['--login', '-i'], exists),
    shellCandidate('wsl', 'Windows Subsystem for Linux', wsl, [], exists),
  ].filter((candidate): candidate is TerminalShell => candidate !== null);
}

function shellCandidate(
  id: string,
  label: string,
  shell: string | undefined,
  args: string[],
  exists: (candidate: string) => boolean,
): TerminalShell | null {
  if (!shell || !exists(shell)) return null;
  return {
    id,
    label,
    description: `Open ${label} in the active workspace.`,
    shell,
    args,
    isDefault: false,
  };
}

function absoluteExisting(
  candidate: string | undefined,
  exists: (candidate: string) => boolean,
): string | undefined {
  return candidate && path.isAbsolute(candidate) && exists(candidate) ? candidate : undefined;
}

function firstExisting(
  candidates: Array<string | undefined>,
  exists: (candidate: string) => boolean,
): string | undefined {
  return candidates.find((candidate): candidate is string => Boolean(candidate && exists(candidate)));
}

function findOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): string | undefined {
  const value = env.PATH || env.Path || '';
  return firstExisting(
    value.split(';').filter(Boolean).map((directory) => path.win32.join(directory, executable)),
    exists,
  );
}

function fallbackShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): TerminalShell {
  if (platform === 'win32') {
    return {
      id: 'cmd',
      label: 'Command Prompt',
      description: 'Open Command Prompt in the active workspace.',
      shell: env.ComSpec || 'cmd.exe',
      args: [],
      isDefault: true,
    };
  }
  return {
    id: 'default',
    label: 'Default shell',
    description: 'Open the operating-system shell in the active workspace.',
    shell: env.SHELL || '/bin/sh',
    args: ['-i'],
    isDefault: true,
  };
}
