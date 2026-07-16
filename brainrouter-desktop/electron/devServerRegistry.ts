/**
 * DEV-SERVER REGISTRY (Desktop side) — starts/stops the workspace's
 * `.claude/launch.json` dev servers and can append a new (validated) config. It
 * backs the Servers panel and is shared with the Browser host, whose story
 * auto-host (`ensureApp`) delegates the actual spawn/track/probe to `start()`.
 *
 * Extracted from the Browser host so a single, name-keyed registry owns every
 * running dev process (the host previously owned one anonymous `devServer`). All
 * the safety guards travel with it: only a whitelisted launcher is spawned, no
 * arg may carry a shell metacharacter (spawn uses shell:true on Windows), and the
 * desktop app's OWN dev port (5173) is refused everywhere (CWE-78).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { findFreePort, isPortFree } from './portUtil.js';
import { isAllowedLauncher, hasShellMeta, hasDangerousFlag, hasExecSubcommand } from './browserSafety.js';

/** The desktop app's own vite dev port — never auto-start or accept a config on it. */
export const DESKTOP_PORT = 5173;

/** One launch.json dev config as read + guarded off disk. */
export interface LaunchConfig {
  name: string;
  exe: string;
  args: string[];
  port: number;
}

/** A dev server we spawned + are tracking, with a bounded log ring buffer. */
export interface RunningServer {
  name: string;
  child: ChildProcess;
  port: number;
  startedAt: string;
  logs: string[];
}

/** A launch.json config joined with its live run state — the Servers panel row. */
export interface ServerStatus {
  name: string;
  exe: string;
  args: string[];
  port: number;
  url: string;
  status: 'running' | 'stopped';
  pid: number | null;
  startedAt: string | null;
  /** Transient (set by start()): true when THIS call spawned a new process. */
  started?: boolean;
  error?: string;
  note?: string;
}

export interface DevServerRegistry {
  list(): ServerStatus[];
  start(name: string): Promise<ServerStatus>;
  stop(name: string): { ok: boolean };
  get(name: string): ServerStatus | undefined;
  tail(name: string, n?: number): string[];
  addConfig(input: { name: string; exe: string; args: string[]; port: number }): { ok: boolean; error?: string };
  disposeAll(): void;
}

/** Port of a URL (defaulting 80/443 by scheme); 0 if unparseable. */
export function portOf(url: string): number {
  try { const u = new URL(url); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return 0; }
}

/** Is anything answering HTTP on this loopback port? */
export function probe(port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    // 'localhost' (not '127.0.0.1'): a dev server may bind IPv6 ::1 (Vite's
    // Windows default) or IPv4 — Node resolves localhost to both and connects
    // to whichever answers, so we detect the server regardless of family.
    const req = http.get({ host: 'localhost', port, path: '/', timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      void probe(port, 800).then((ok) => {
        if (ok) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

const launchConfigPath = (workspaceRoot: string): string => path.join(workspaceRoot, '.claude', 'launch.json');

/**
 * Read + guard the workspace's launch.json dev configs. launch.json is
 * repo-controlled — only spawn a whitelisted launcher, and reject any arg
 * carrying a shell metacharacter. A config that fails a guard is DROPPED, not run.
 */
export function readLaunchConfigs(workspaceRoot: string): LaunchConfig[] {
  try {
    const j = JSON.parse(fs.readFileSync(launchConfigPath(workspaceRoot), 'utf8')) as { configurations?: unknown };
    const arr = Array.isArray(j.configurations) ? j.configurations : [];
    return arr
      .map((c) => {
        const o = c as { name?: unknown; runtimeExecutable?: unknown; runtimeArgs?: unknown; port?: unknown };
        return {
          name: String(o.name ?? ''),
          exe: String(o.runtimeExecutable ?? 'npm'),
          args: Array.isArray(o.runtimeArgs) ? o.runtimeArgs.map(String) : [],
          port: Number(o.port) || 0,
        };
      })
      .filter((c) => c.name && c.port > 0 && isAllowedLauncher(c.exe) && !c.args.some(hasShellMeta) && !c.args.some(hasDangerousFlag) && !hasExecSubcommand(c.exe, c.args));
  } catch {
    return [];
  }
}

export function createDevServerRegistry(workspaceRoot: string): DevServerRegistry {
  // Name-keyed — one running process per launch.json config name.
  const servers = new Map<string, RunningServer>();

  const urlFor = (port: number): string => `http://localhost:${port}`;

  const statusOf = (name: string): ServerStatus => {
    const cfg = readLaunchConfigs(workspaceRoot).find((c) => c.name === name);
    const run = servers.get(name);
    const alive = !!run && run.child.exitCode === null && !run.child.killed;
    return {
      name,
      exe: cfg?.exe ?? 'npm',
      args: cfg?.args ?? [],
      port: run?.port ?? cfg?.port ?? 0,
      url: urlFor(run?.port ?? cfg?.port ?? 0),
      status: alive ? 'running' : 'stopped',
      pid: alive ? run?.child.pid ?? null : null,
      startedAt: alive ? run?.startedAt ?? null : null,
    };
  };

  function killRunning(run: RunningServer): void {
    const pid = run.child.pid;
    try {
      if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { run.child.kill('SIGTERM'); } }
      else run.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  function list(): ServerStatus[] {
    const out: ServerStatus[] = [];
    const seen = new Set<string>();
    for (const cfg of readLaunchConfigs(workspaceRoot)) { out.push(statusOf(cfg.name)); seen.add(cfg.name); }
    // Surface any still-running server whose config was removed from launch.json.
    for (const name of servers.keys()) if (!seen.has(name)) out.push(statusOf(name));
    return out;
  }

  async function start(name: string): Promise<ServerStatus> {
    const cfg = readLaunchConfigs(workspaceRoot).find((c) => c.name === name);
    if (!cfg) return { ...statusOf(name), error: `no dev config named "${name}" in .claude/launch.json` };
    // Runtime guard: never spawn on the desktop app's OWN dev port.
    if (cfg.port === DESKTOP_PORT) {
      return { ...statusOf(name), error: `refusing to start on :${DESKTOP_PORT} — that's the desktop app's own dev port` };
    }
    // Already tracked + alive (and still serving)? reuse it.
    const existing = servers.get(name);
    if (existing && existing.child.exitCode === null && (await probe(existing.port))) {
      return { ...statusOf(name), started: false };
    }
    // Something already serving the configured port (started outside the app)?
    if (await probe(cfg.port)) return { ...statusOf(name), status: 'running', port: cfg.port, url: urlFor(cfg.port), started: false };

    // Pick a bindable port — cfg.port if free, else the next free one nearby.
    if (existing) { killRunning(existing); servers.delete(name); }
    let port = cfg.port;
    let note: string | undefined;
    if (!(await isPortFree(cfg.port))) {
      const alt = await findFreePort(cfg.port + 1);
      if (!alt) return { ...statusOf(name), error: `port ${cfg.port} is in use and no free port was found near it` };
      note = `Port ${cfg.port} is in use — starting "${name}" on ${alt} instead.`;
      port = alt;
    }
    // A free-port fallback could still land on the desktop's own dev port.
    if (port === DESKTOP_PORT) {
      return { ...statusOf(name), error: `refusing to auto-start on :${DESKTOP_PORT} — that's the desktop app's own dev port` };
    }

    const isWin = process.platform === 'win32';
    const exe = isWin && /^npm$/i.test(cfg.exe) ? 'npm.cmd' : cfg.exe;
    // When we move ports, pass the override to the dev command (npm scripts + vite
    // and friends accept `-- --port <n>`); on the configured port, run it verbatim.
    const args = port === cfg.port ? cfg.args : [...cfg.args, '--', '--port', String(port)];
    let child: ChildProcess;
    try {
      // Put the workspace's node_modules/.bin on PATH so whitelisted local tool
      // binaries (vite/nx/turbo) resolve directly — the safe replacement for `npx`
      // (which was removed because it can fetch + run an arbitrary package).
      const binDir = path.join(workspaceRoot, 'node_modules', '.bin');
      const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
      child = spawn(exe, args, { cwd: workspaceRoot, env, detached: !isWin, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return { ...statusOf(name), error: `start dev server "${name}" failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const run: RunningServer = { name, child, port, startedAt: new Date().toISOString(), logs: [] };
    // Drain stdout/stderr into a bounded ring buffer — an UNREAD pipe can back-pressure
    // and stall a chatty dev server, so we must consume it.
    const capture = (chunk: unknown): void => {
      const text = String(chunk);
      run.logs.push(text);
      if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    servers.set(name, run);
    child.on('exit', () => { if (servers.get(name)?.child === child) servers.delete(name); });

    const ready = await waitForPort(port, 30000);
    if (!ready) {
      killRunning(run);
      servers.delete(name);
      return { ...statusOf(name), port, url: urlFor(port), error: `dev server "${name}" did not become ready on :${port} within 30s`, note };
    }
    return { ...statusOf(name), status: 'running', port, url: urlFor(port), pid: child.pid ?? null, startedAt: run.startedAt, started: true, note };
  }

  function stop(name: string): { ok: boolean } {
    const run = servers.get(name);
    servers.delete(name);
    if (!run?.child) return { ok: false };
    killRunning(run);
    return { ok: true };
  }

  function tail(name: string, n = 200): string[] {
    const run = servers.get(name);
    if (!run) return [];
    // logs is chunk-keyed; flatten to lines and return the last n.
    const lines = run.logs.join('').split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-n);
  }

  function addConfig(input: { name: string; exe: string; args: string[]; port: number }): { ok: boolean; error?: string } {
    const name = String(input.name ?? '').trim();
    const exe = String(input.exe ?? '').trim() || 'npm';
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const port = Number(input.port);
    // Validate BEFORE any write — never spawn from add.
    if (!name) return { ok: false, error: 'a non-empty server name is required.' };
    if (!isAllowedLauncher(exe)) return { ok: false, error: `launcher "${exe}" is not allowed (npm/npx/pnpm/yarn/vite/nx/turbo only).` };
    if (args.some(hasShellMeta)) return { ok: false, error: 'an argument contains a shell metacharacter.' };
    if (args.some(hasDangerousFlag)) return { ok: false, error: 'an argument is an inline code-execution flag (-e/-p/-r/-c).' };
    if (hasExecSubcommand(exe, args)) return { ok: false, error: 'that subcommand (exec/x/dlx/create/add/install) runs an arbitrary package — use a project script (run <script>).' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port must be an integer in 1..65535.' };
    if (port === DESKTOP_PORT) return { ok: false, error: `port ${DESKTOP_PORT} is the desktop app's own dev port.` };

    let doc: { version?: unknown; configurations?: unknown } = { version: '0.0.1', configurations: [] };
    const file = launchConfigPath(workspaceRoot);
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') doc = parsed as typeof doc;
      }
    } catch {
      return { ok: false, error: '.claude/launch.json is present but unreadable/malformed.' };
    }
    const configs = Array.isArray(doc.configurations) ? (doc.configurations as Array<Record<string, unknown>>) : [];
    if (configs.some((c) => String(c?.name ?? '') === name)) return { ok: false, error: `a config named "${name}" already exists.` };
    configs.push({ name, runtimeExecutable: exe, runtimeArgs: args, port });
    doc.configurations = configs;
    if (doc.version == null) doc.version = '0.0.1';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, error: `writing .claude/launch.json failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true };
  }

  function disposeAll(): void {
    for (const run of servers.values()) killRunning(run);
    servers.clear();
  }

  return { list, start, stop, get: statusOf, tail, addConfig, disposeAll };
}
