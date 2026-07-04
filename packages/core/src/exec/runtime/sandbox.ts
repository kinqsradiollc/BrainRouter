import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCliKnobs } from '../../config/config.js';
import {
  getSecretBroker,
  hasSecretLeaseEnv,
  leaseSecretEnv,
  resolveLeaseEnv,
} from '../../runtime/secrets/secretBroker.js';

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
  /**
   * CODEX-SANDBOX-UNATTENDED — true when the sandbox was forced on for a
   * silent / unattended agent (rather than the user's `cli.sandbox` setting).
   * Surfaced so the agent can badge the run as "(enforced: unattended)".
   */
  enforcedUnattended?: boolean;
  /**
   * HONK-H0 — when set, the scrubbed environment a sandboxed shell runs with
   * (secret-shaped vars removed). Absent → the command inherits the full env.
   */
  scopedEnv?: NodeJS.ProcessEnv;
  /**
   * MC-A5 — scope tag the JIT secret leases in `scopedEnv` were issued under
   * (set only when `cli.runtime.jitSecrets` is on). `runShell` presents it
   * back to the broker when it redeems the leases at spawn time.
   */
  leaseScope?: string;
}

// HONK-H0 — best-effort secret scrubbing for an unattended/fleet shell's env. This
// is DEFENSE-IN-DEPTH, not a hermetic barrier: the real containment for fleet runs
// is the forced sandbox + network-deny. It removes env-borne secrets so a
// compromised child can't trivially `printenv` the host's keys; it does NOT cover
// file-borne secrets (e.g. ~/.aws, the CLI config) and the shapes below are not
// exhaustive. Substring name-matching is intentional (fails CLOSED: over-scrubs a
// benign var rather than leaking a real one); the operator re-grants specific vars
// a job needs with cli.jobSecretAllowlist.
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|\bPWD\b|PWD$|PASSPHRASE|CREDENTIAL|PRIVATE|BEARER|AUTH|SESSION|COOKIE|APIKEY|_DSN)/i;
const SECRET_ENV_VALUE = new RegExp(
  [
    'br_[A-Za-z0-9._-]{8,}', 'sk-[A-Za-z0-9._-]{8,}', 'gh[pousr]_[A-Za-z0-9]{16,}', // BrainRouter / OpenAI / GitHub
    'AKIA[0-9A-Z]{16}', 'xox[baprs]-[A-Za-z0-9-]{10,}', 'AIza[0-9A-Za-z_-]{20,}', // AWS / Slack / Google
    '[A-Za-z][A-Za-z0-9+.-]*://[^/\\s:@]+:[^/\\s@]+@', // url with user:password@host (DATABASE_URL/REDIS_URL)
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', // JWT
  ].join('|'),
);

/**
 * HONK-H0 — return a copy of `env` with secret-shaped variables removed (best
 * effort; see SECRET_ENV_NAME). A var is dropped when its NAME contains a secret
 * keyword or its VALUE matches a known token/credential shape, unless its name is
 * in `allow` (case-insensitive). Non-secret vars (PATH, HOME, LANG, …) pass
 * through so the shell still works. Pure — never reads `process.env` itself.
 */
/**
 * MC-A5 — shared secret-shape detector: true when an env var looks like a
 * credential by NAME or VALUE (same heuristics `scopeSecretEnv` scrubs with).
 * The JIT-secret lease layer uses this to decide which vars to indirect.
 */
export function isSecretShapedEnvVar(name: string, value: string | undefined): boolean {
  if (SECRET_ENV_NAME.test(name)) return true;
  return typeof value === 'string' && SECRET_ENV_VALUE.test(value.trim());
}

export function scopeSecretEnv(env: NodeJS.ProcessEnv, opts?: { allow?: string[] }): NodeJS.ProcessEnv {
  const allow = new Set((opts?.allow ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (allow.has(name.toLowerCase())) { out[name] = value; continue; }
    if (isSecretShapedEnvVar(name, value)) continue;
    out[name] = value;
  }
  return out;
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
  opts?: { silent?: boolean; enforceWhenSilent?: boolean; forceEnforce?: boolean; scopeSecrets?: boolean },
): SandboxConfig {
  const knobs = getCliKnobs();
  const cfgReads = knobs.sandboxReadPaths;
  const cfgWrites = knobs.sandboxWritePaths;
  const readPaths = Array.from(new Set([...(persistedExtras?.readPaths ?? []), ...cfgReads]));
  const writePaths = Array.from(new Set([...(persistedExtras?.writePaths ?? []), ...cfgWrites]));

  // CODEX-SANDBOX-UNATTENDED — when an agent runs silent/unattended (cloud
  // worker, spawned child, non-interactive), there is no human to approve or
  // notice a risky shell call. Unless explicitly opted out, force the sandbox
  // on with the strictest posture (network denied, missing-sandboxer fails
  // closed) regardless of the looser interactive `cli.sandbox*` settings.
  // Callers may pass an already-resolved `enforceWhenSilent` (e.g. the agent
  // captures it at construction) so the decision is stable across the turn;
  // otherwise fall back to the live knob.
  // HONK-H0 — a fleet/background role passes `forceEnforce` so its sandbox can't
  // be disabled by an operator's `cli.sandboxEnforceWhenSilent: false` opt-out.
  const enforceWhenSilent = opts?.enforceWhenSilent ?? knobs.sandboxEnforceWhenSilent;
  // `forceEnforce` (fleet) forces the locked-down posture independently of `silent`,
  // so a future non-silent fleet entry point can't silently bypass it.
  const enforcedUnattended = (!!opts?.silent && enforceWhenSilent) || !!opts?.forceEnforce;
  const enabled = knobs.sandbox === 'on' || enforcedUnattended;
  const allowNetwork = enforcedUnattended ? false : knobs.sandboxNetwork;
  const unavailableMode: SandboxUnavailableMode = enforcedUnattended ? 'deny' : knobs.sandboxUnavailable;
  // HONK-H0 — scrub secret-shaped env vars from a shell when the caller opts in
  // (fleet roles do), gated by the `jobSecretScoping` global kill switch and only
  // for enforced runs. The operator can allowlist specific vars a job needs.
  const scopeSecrets = !!opts?.scopeSecrets && knobs.jobSecretScoping && enforcedUnattended;
  let scopedEnv = scopeSecrets ? scopeSecretEnv(process.env, { allow: knobs.jobSecretAllowlist }) : undefined;
  // MC-A5 — with JIT secrets on, the allowlisted secret-shaped vars that
  // survived scrubbing travel as single-use lease tokens instead of raw
  // values; `runShell` redeems them from the broker right before spawn (the
  // point of use). Default off → scopedEnv is exactly the HONK-H0 output.
  let leaseScope: string | undefined;
  if (scopedEnv && knobs.runtime.jitSecrets) {
    leaseScope = `exec:${workspaceRoot}`;
    scopedEnv = leaseSecretEnv(scopedEnv, getSecretBroker(), {
      ttlMs: knobs.runtime.jitSecretTtlMs,
      scope: leaseScope,
      isSecret: isSecretShapedEnvVar,
    });
  }
  return { enabled, workspaceRoot, readPaths, writePaths, allowNetwork, unavailableMode, enforcedUnattended, scopedEnv, leaseScope };
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
  /** DESK-6 — true when the user pressed Stop and the child was killed mid-run. */
  interrupted?: boolean;
}

/**
 * Execute `command` (a shell string) with optional sandboxing. Returns a
 * normalized result. Always returns; never throws on non-zero exit.
 */
export async function runShell(command: string, config: SandboxConfig, timeoutMs = 120_000, signal?: AbortSignal): Promise<SandboxRunResult> {
  // Always pin cwd to the workspace root so `run_command` never inherits a
  // drifted process.cwd() (and writes test files into ~/.brainrouter).
  const cwd = config.workspaceRoot;
  // MC-A5 — point-of-use: redeem any JIT secret leases riding in scopedEnv
  // right before the child spawns. Leases are single-use per command (each
  // `resolveSandboxConfig` call mints fresh ones). A lease that fails to
  // redeem drops its var — the child never sees a dangling token.
  const runEnv = await materializeLeaseEnv(config.scopedEnv, config.leaseScope);
  if (!config.enabled) {
    return execShell(command, undefined, cwd, timeoutMs, false, 'none', signal, runEnv);
  }

  if (process.platform === 'darwin') {
    const profilePath = writeMacSandboxProfile(config);
    const wrapped = ['sandbox-exec', '-f', profilePath, '/bin/sh', '-c', command];
    const r = await execShell(wrapped[0], wrapped.slice(1), cwd, timeoutMs, true, 'sandbox-exec', signal, runEnv);
    r.sandboxDenied = detectSandboxDenial(r.stderr);
    return r;
  }

  if (process.platform === 'linux') {
    if (await binaryAvailable('bwrap')) {
      const args = buildBwrapArgs(config, command);
      const r = await execShell('bwrap', args, cwd, timeoutMs, true, 'bwrap', signal, runEnv);
      r.sandboxDenied = detectSandboxDenial(r.stderr);
      return r;
    }
    if (await binaryAvailable('firejail')) {
      const args = buildFirejailArgs(config, command);
      const r = await execShell('firejail', args, cwd, timeoutMs, true, 'firejail', signal, runEnv);
      r.sandboxDenied = detectSandboxDenial(r.stderr);
      return r;
    }
    return handleUnavailableSandbox(config, command, cwd, timeoutMs, 'Linux (no bwrap/firejail)', signal, runEnv);
  }

  // Windows / other — no portable sandbox in stdlib.
  return handleUnavailableSandbox(config, command, cwd, timeoutMs, process.platform, signal, runEnv);
}

/**
 * MC-A5 — resolve `BRAINROUTER_SECRET_LEASE_*` entries back into raw values
 * via the process-wide broker. No leases present (the default-off path) →
 * the env is returned untouched.
 */
async function materializeLeaseEnv(
  env: NodeJS.ProcessEnv | undefined,
  leaseScope: string | undefined,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (!env || !hasSecretLeaseEnv(env)) return env;
  const resolved = await resolveLeaseEnv(env, getSecretBroker(), { scope: leaseScope });
  return resolved.env;
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
  signal?: AbortSignal,
  runEnv?: NodeJS.ProcessEnv,
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
  const fallback = await execShell(command, undefined, cwd, timeoutMs, false, 'none', signal, runEnv ?? config.scopedEnv);
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
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<SandboxRunResult> {
  return new Promise((resolve) => {
    // DESK-6 — already stopped before we even spawned.
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'interrupted by user', exitCode: 130, sandboxed, sandboxTool: tool, interrupted: true });
      return;
    }
    const useShell = !args; // when no args provided, run as a single shell string
    // HONK-H0 — `env` (when provided) is the secret-scoped environment; undefined
    // inherits the full process env (the non-enforced default).
    const child = useShell
      ? spawn(cmd, { cwd, shell: true, env })
      : spawn(cmd, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    // DESK-6 — the user pressed Stop: SIGKILL the child NOW (sandbox wrappers may
    // not forward SIGTERM to the inner shell, so go straight to SIGKILL) and
    // resolve with a clean interrupted envelope (exit 130), not a generic 127.
    const onAbort = (): void => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ stdout, stderr: stderr || 'interrupted by user', exitCode: 130, sandboxed, sandboxTool: tool, interrupted: true });
    };
    const finish = (r: SandboxRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      finish({ stdout, stderr, exitCode: code ?? 0, sandboxed, sandboxTool: tool });
    });
    child.on('error', (err) => {
      finish({ stdout: '', stderr: err.message, exitCode: 127, sandboxed, sandboxTool: tool });
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
  // sandbox-exec `subpath` matches the kernel-RESOLVED path. On macOS `/tmp`,
  // `/var`, and `/var/folders/...` temp dirs are symlinks into `/private/...`,
  // so a profile that allows the raw path silently denies every write under it.
  // Resolve each write root to its realpath (falling back to the raw path when
  // it doesn't exist yet) so the allow actually takes effect.
  const writeRoots = Array.from(
    new Set([config.workspaceRoot, '/tmp', os.tmpdir(), ...config.writePaths].map(realpathOrSelf)),
  );
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork process-exec)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)', // permissive on reads — sandboxing writes is the priority
  ];
  for (const p of writeRoots) {
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

/** Resolve symlinks (e.g. macOS /var → /private/var) so sandbox `subpath`
 * rules match the kernel-resolved path; fall back to the raw path if the
 * target doesn't exist yet. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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
