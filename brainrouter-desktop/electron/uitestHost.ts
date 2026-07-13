/**
 * UI-TEST HOST (Desktop side) — the host-side glue for the "UI Tests" panel. It
 * owns the workspace walk + incremental `data-testid` extraction (re-parse only
 * changed files) and persists the manifest; the driver, base URL, command layer,
 * and manifest sharing all live in the package's shared SESSION, so the panel and
 * the agent's `ui_*` tools drive the SAME headed browser over the SAME command
 * layer (one browser, two consumers).
 *
 * Imports the headless engine the same way host.ts imports the CLI runtime —
 * a deep import into the built package (resolved via the workspace symlink).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  extractFile,
  assembleManifest,
  diffManifests,
  hashContent,
  errorResult,
  getUiTestSession,
  manifestPathFor,
  parseFlowYaml,
  serializeFlowYaml,
  parseStoryYaml,
  parseStoriesJson,
  serializeStoryYaml,
  runFlow as runFlowSteps,
  type CommandLayer,
  type UiMap,
  type FileSites,
  type Device,
  type UiCommandResult,
  type ManifestDiff,
  type Story,
} from '@kinqs/brainrouter-ui-test';
import { shouldIgnoreWatchPath } from './fileWatch.js';
import { findFreePort, isPortFree } from './portUtil.js';
// IPC is agent-reachable — names + extract paths it receives are untrusted.
import { safeName, isPathWithinRoot, mdSafe, isAllowedLauncher, hasShellMeta } from './uitestSafety.js';
import { isLoopbackHttpSrc } from './webviewPolicy.js';

/**
 * The `uitest:*` channel is agent-reachable — log the full error to the dev
 * console but return a GENERIC message across IPC so fs paths / env / stack
 * traces don't leak to the caller (CWE-209).
 */
function ipcError(err: unknown, what: string): string {
  console.error(`[uitest] ${what} failed:`, err);
  return `${what} failed`;
}

const SOURCE_RE = /\.[jt]sx?$/i;
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;

/** A single panel/agent request: an element action (target = element id) or a
 *  navigate (target = screen id). Mirrors the package's FlowStep. */
export interface UiTestStep {
  action: 'navigate' | 'tap' | 'type' | 'assertVisible';
  target: string;
  text?: string;
}

/** One executed story step's outcome, captured live in the Browser panel. */
export interface UiTestStepResult {
  i: number;
  action: string;
  target: string;
  ok: boolean;
  error?: string;
  ms?: number;
}

/** A captured screenshot handed back from the Browser panel (data URL / base64). */
export interface UiTestShot {
  name: string;
  dataUrl: string;
}

/** A finished story run to turn into a markdown report. */
export interface UiRunReportInput {
  story: { id?: string; title?: string };
  baseUrl?: string;
  results: UiTestStepResult[];
  screenshots?: UiTestShot[];
}

export interface UiTestHost {
  /** Full workspace walk, or (with `only`) re-extract just those files and merge
   *  into the existing map. `broad` also captures interactive elements without
   *  data-testid (the whole-app map); toggling it re-extracts from scratch. */
  extract(opts?: { only?: string[]; broad?: boolean }): { manifest: UiMap; diff: ManifestDiff; degraded: boolean; fileCount: number };
  manifest(): { manifest: UiMap | null };
  setUrl(url: string): { ok: boolean; url: string };
  getUrl(): string;
  runCommand(step: UiTestStep): Promise<{ result: UiCommandResult }>;
  setDevice(device: Device): Promise<{ result: UiCommandResult }>;
  listFlows(): { flows: string[] };
  saveFlow(name: string, steps: UiTestStep[]): { ok: boolean; name: string; error?: string };
  runFlow(arg: { name?: string; steps?: UiTestStep[] }): Promise<{ results: UiCommandResult[] }>;
  /** Saved user-journey stories (`.brainrouter/ui-tests/stories/*.story.yaml`). */
  listStories(): { stories: Story[] };
  saveStory(story: Story): { ok: boolean; id: string; error?: string };
  /** Persist a captured screenshot (data URL / base64) under
   *  `.brainrouter/ui-tests/screenshots/`; returns its workspace-relative path. */
  saveScreenshot(opts: { dataUrl?: string; base64?: string; name?: string }): { path?: string; error?: string };
  /** Build a markdown run report (saving its screenshots) under
   *  `.brainrouter/ui-tests/reports/`; the host then registers it as an Artifact. */
  runReport(input: UiRunReportInput): { reportPath?: string; markdown?: string; screenshots?: string[]; error?: string };
  /** Ensure a dev server is serving the app: reuse the URL if it responds, else
   *  start the dev server from `.claude/launch.json` and wait until it's ready. */
  ensureApp(opts?: { name?: string; url?: string }): Promise<{ url: string; started: boolean; error?: string; note?: string }>;
  stopDriver(): Promise<{ ok: boolean }>;
  dispose(): void;
}

function sanitizeFlowName(name: string): string {
  // path.basename first so an agent-supplied `../evil` / absolute path can't
  // escape the flows/stories/screenshots dir it's joined into.
  return safeName(name, 'flow');
}

async function dispatch(layer: CommandLayer, step: UiTestStep): Promise<UiCommandResult> {
  switch (step.action) {
    case 'navigate':
      return layer.navigate(step.target);
    case 'tap':
      return layer.tap(step.target);
    case 'type':
      return layer.type(step.target, step.text ?? '');
    case 'assertVisible':
      return layer.assertVisible(step.target);
    default:
      return errorResult('unknown', `unknown action: ${String((step as { action?: string }).action)}`);
  }
}

export function createUiTestHost(workspaceRoot: string): UiTestHost {
  // In-memory incremental state: re-parse only files whose hash changed.
  const fileSites = new Map<string, FileSites>();
  const hashes = new Map<string, string>();
  let lastBroad: boolean | undefined; // extraction mode the cache was built in
  const session = () => getUiTestSession(workspaceRoot);

  function writeManifest(m: UiMap): void {
    try {
      const p = manifestPathFor(workspaceRoot);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n', 'utf8');
    } catch {
      /* best-effort */
    }
  }

  /** Recursively read workspace `.ts/.tsx`, skipping ignored dirs + huge files. */
  function walk(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    const stack: string[] = ['.'];
    while (stack.length && out.length < MAX_FILES) {
      const rel = stack.pop()!;
      const abs = rel === '.' ? workspaceRoot : path.join(workspaceRoot, rel);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
        if (shouldIgnoreWatchPath(childRel)) continue;
        if (e.isDirectory()) {
          stack.push(childRel);
        } else if (e.isFile() && SOURCE_RE.test(e.name)) {
          try {
            const full = path.join(workspaceRoot, childRel);
            if (fs.statSync(full).size > MAX_BYTES) continue;
            out.push({ path: childRel.split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
          } catch {
            /* unreadable — skip */
          }
          if (out.length >= MAX_FILES) break;
        }
      }
    }
    return out;
  }

  /** Read specific workspace-relative source files — the scoped "extract
   *  selected" path. Applies the same source/ignore/size guards as `walk`. */
  function readOnly(paths: string[]): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    // Canonicalize the root once so the symlink check below compares real paths.
    let realRoot: string;
    try { realRoot = fs.realpathSync(workspaceRoot); } catch { realRoot = path.resolve(workspaceRoot); }
    const seen = new Set<string>();
    for (const rel of paths) {
      const norm = String(rel ?? '').split(path.sep).join('/');
      if (!norm || seen.has(norm) || !SOURCE_RE.test(norm) || shouldIgnoreWatchPath(norm)) continue;
      seen.add(norm);
      // Containment: an agent can pass `extract({ only: ['../../etc/passwd.ts'] })`
      // — a `..` escape still matches SOURCE_RE, so reject anything resolving
      // outside the workspace before touching the filesystem.
      if (!isPathWithinRoot(workspaceRoot, norm)) continue;
      try {
        const full = path.join(workspaceRoot, norm);
        // Symlink guard: the lexical check above can't see a symlink pointing
        // outside the workspace. Resolve the REAL path and re-check containment
        // before reading, so `symlink-dir/file.ts` can't escape the repo.
        const realFull = fs.realpathSync(full);
        if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) continue;
        if (fs.statSync(full).size > MAX_BYTES) continue;
        out.push({ path: norm, text: fs.readFileSync(full, 'utf8') });
      } catch {
        /* unreadable — skip */
      }
    }
    return out;
  }

  function extract(opts?: { only?: string[]; broad?: boolean }): { manifest: UiMap; diff: ManifestDiff; degraded: boolean; fileCount: number } {
    const broad = !!opts?.broad;
    // Toggling broad ⇄ precise changes what every file yields, so drop the
    // incremental cache — otherwise unchanged files keep their old-mode sites.
    if (broad !== lastBroad) { fileSites.clear(); hashes.clear(); lastBroad = broad; }
    const only = opts?.only?.length ? opts.only : null;
    const files = only ? readOnly(only) : walk();
    const present = new Set(files.map((f) => f.path));
    let degraded = false;
    for (const f of files) {
      const h = hashContent(f.text);
      if (hashes.get(f.path) === h && fileSites.has(f.path)) continue; // unchanged → no re-parse
      const r = extractFile(f.path, f.text, { broad });
      if (r.degraded) degraded = true;
      fileSites.set(f.path, { path: f.path, sites: r.sites, degraded: r.degraded });
      hashes.set(f.path, h);
    }
    // Prune deleted files only on a FULL walk — a scoped extract refreshes the
    // selected files and keeps every other screen already in the map.
    if (!only) {
      for (const p of [...fileSites.keys()]) {
        if (!present.has(p)) {
          fileSites.delete(p);
          hashes.delete(p);
        }
      }
    }
    const { manifest } = assembleManifest([...fileSites.values()], { broad });
    const prev = session().manifest();
    const diff = diffManifests(prev ?? undefined, manifest);
    session().setManifest(manifest);
    writeManifest(manifest);
    // `degraded` (local) only sees files re-parsed THIS call; an incremental run
    // with no changed files would report false even while cached sites are still
    // degraded. The assembled manifest folds in every cached site, so it's the
    // authoritative signal — keep the return consistent across incremental runs.
    return { manifest, diff, degraded: degraded || !!manifest.degraded, fileCount: files.length };
  }

  const flowsDir = (): string => path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'flows');

  function listFlows(): { flows: string[] } {
    try {
      return {
        flows: fs
          .readdirSync(flowsDir())
          .filter((f) => f.endsWith('.flow.yaml'))
          .map((f) => f.replace(/\.flow\.yaml$/, ''))
          .sort(),
      };
    } catch {
      return { flows: [] };
    }
  }

  function saveFlow(name: string, steps: UiTestStep[]): { ok: boolean; name: string; error?: string } {
    try {
      const safe = sanitizeFlowName(name);
      const yaml = serializeFlowYaml({ name: safe, steps: steps as never });
      fs.mkdirSync(flowsDir(), { recursive: true });
      fs.writeFileSync(path.join(flowsDir(), `${safe}.flow.yaml`), yaml, 'utf8');
      return { ok: true, name: safe };
    } catch (err) {
      return { ok: false, name, error: ipcError(err, 'save flow') };
    }
  }

  async function runFlow(arg: { name?: string; steps?: UiTestStep[] }): Promise<{ results: UiCommandResult[] }> {
    let steps: UiTestStep[] = [];
    if (arg.name) {
      try {
        steps = parseFlowYaml(fs.readFileSync(path.join(flowsDir(), `${sanitizeFlowName(arg.name)}.flow.yaml`), 'utf8')).steps as never;
      } catch {
        return { results: [errorResult('runFlow', `flow not found: ${arg.name}`)] };
      }
    } else if (Array.isArray(arg.steps)) {
      steps = arg.steps;
    }
    return { results: await runFlowSteps(session().layer, steps as never) };
  }

  // --- Stories (named user journeys) ---------------------------------------
  const storiesDir = (): string => path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'stories');

  function listStories(): { stories: Story[] } {
    // Merge three sources, deduped by id (later sources override earlier):
    //   1. a TRACKED seed (<workspace>/stories.seed.json) so example journeys
    //      survive a `git clean` of the gitignored .brainrouter dir,
    //   2. the JSON manifest (.brainrouter/ui-tests/stories.json),
    //   3. per-story YAML (.brainrouter/ui-tests/stories/*.story.yaml).
    const byId = new Map<string, Story>();
    const readJson = (file: string): void => {
      try { if (fs.existsSync(file)) for (const s of parseStoriesJson(fs.readFileSync(file, 'utf8'))) byId.set(s.id, s); } catch { /* ignore a bad file */ }
    };
    readJson(path.join(workspaceRoot, 'stories.seed.json'));
    readJson(path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'stories.json'));
    try {
      const dir = storiesDir();
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.story.yaml')) continue;
        try { const s = parseStoryYaml(fs.readFileSync(path.join(dir, f), 'utf8')); byId.set(s.id, s); } catch { /* skip a bad story */ }
      }
    } catch { /* no stories dir yet */ }
    const out = [...byId.values()].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    return { stories: out };
  }

  function saveStory(story: Story): { ok: boolean; id: string; error?: string } {
    try {
      const safe = sanitizeFlowName(story.id);
      fs.mkdirSync(storiesDir(), { recursive: true });
      fs.writeFileSync(path.join(storiesDir(), `${safe}.story.yaml`), serializeStoryYaml({ ...story, id: safe }), 'utf8');
      return { ok: true, id: safe };
    } catch (err) {
      return { ok: false, id: story.id, error: ipcError(err, 'save story') };
    }
  }

  // --- Screenshots + run reports -------------------------------------------
  const screenshotsDir = (): string => path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'screenshots');
  const reportsDir = (): string => path.join(workspaceRoot, '.brainrouter', 'ui-tests', 'reports');
  const relFromRoot = (abs: string): string => path.relative(workspaceRoot, abs).split(path.sep).join('/');
  const stamp = (): string => new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '');
  const mdCell = (s: string | undefined): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  function decodePng(data: string): Buffer | null {
    const m = /^data:image\/\w+;base64,(.+)$/i.exec(data);
    const b64 = m ? m[1] : data;
    if (!b64) return null;
    try { const buf = Buffer.from(b64, 'base64'); return buf.length ? buf : null; } catch { return null; }
  }

  function saveScreenshot(opts: { dataUrl?: string; base64?: string; name?: string }): { path?: string; error?: string } {
    const buf = decodePng(String(opts.dataUrl ?? opts.base64 ?? ''));
    if (!buf) return { error: 'no image data to save' };
    try {
      const dir = screenshotsDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = `${sanitizeFlowName(opts.name || 'shot')}-${stamp()}.png`;
      const abs = path.join(dir, file);
      fs.writeFileSync(abs, buf);
      return { path: relFromRoot(abs) };
    } catch (err) {
      return { error: ipcError(err, 'save screenshot') };
    }
  }

  function buildReportMarkdown(a: { title: string; id: string; baseUrl?: string; results: UiTestStepResult[]; shotPaths: string[]; passed: number }): string {
    const total = a.results.length;
    const allOk = total > 0 && a.passed === total;
    const lines: string[] = [];
    // title / id / baseUrl are agent-supplied (uitest:run-report) — HTML-encode
    // them so an injected tag can't execute if the report is rendered in a webview.
    lines.push(`# UI run: ${mdSafe(a.title)}`, '');
    lines.push(`- **Story:** ${mdSafe(a.id)}`);
    lines.push(`- **When:** ${new Date().toISOString()}`);
    if (a.baseUrl) lines.push(`- **Base URL:** ${mdSafe(a.baseUrl)}`);
    lines.push(`- **Result:** ${a.passed}/${total} step(s) passed ${allOk ? '✅' : '❌'}`, '');
    lines.push('## Steps', '');
    lines.push('| # | Action | Target | Result | Notes |');
    lines.push('|---|--------|--------|--------|-------|');
    for (const r of a.results) {
      const notes = [r.error, r.ms != null ? `${r.ms}ms` : ''].filter(Boolean).join(' · ');
      lines.push(`| ${r.i} | ${mdCell(r.action)} | ${mdCell(r.target)} | ${r.ok ? '✅' : '❌'} | ${mdCell(notes)} |`);
    }
    if (a.shotPaths.length) {
      lines.push('', '## Screenshots', '');
      for (const p of a.shotPaths) {
        // Report lives in …/reports, screenshots in …/screenshots — link relatively.
        const rel = p.replace(/^\.brainrouter\/ui-tests\//, '../');
        lines.push(`![${mdSafe(p.split('/').pop())}](${encodeURI(rel)})`, '');
      }
    }
    return lines.join('\n') + '\n';
  }

  function runReport(input: UiRunReportInput): { reportPath?: string; markdown?: string; screenshots?: string[]; error?: string } {
    try {
      const results = Array.isArray(input.results) ? input.results : [];
      const title = (String(input.story?.title ?? '').trim()) || 'UI run';
      const id = sanitizeFlowName(input.story?.id || title);
      // 1) persist screenshots alongside the report, collect relative paths.
      const shotPaths: string[] = [];
      for (const s of input.screenshots ?? []) {
        const r = saveScreenshot({ dataUrl: s.dataUrl, name: `${id}-${s.name || 'shot'}` });
        if (r.path) shotPaths.push(r.path);
      }
      // 2) build + write the markdown.
      const passed = results.filter((r) => r.ok).length;
      const md = buildReportMarkdown({ title, id, baseUrl: input.baseUrl, results, shotPaths, passed });
      const dir = reportsDir();
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, `${id}-${stamp()}.md`);
      fs.writeFileSync(abs, md, 'utf8');
      return { reportPath: relFromRoot(abs), markdown: md, screenshots: shotPaths };
    } catch (err) {
      return { error: ipcError(err, 'save run report') };
    }
  }

  // --- Auto-host: probe the app URL, else start the dev server + wait --------
  const DESKTOP_PORT = 5173; // the desktop app's own vite — never auto-start it
  let devServer: { child: ChildProcess; port: number } | null = null;

  function readLaunchConfigs(): Array<{ name: string; exe: string; args: string[]; port: number }> {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.claude', 'launch.json'), 'utf8')) as { configurations?: unknown };
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
        // launch.json is repo-controlled — only spawn a whitelisted launcher, and
        // reject any arg carrying a shell metacharacter (spawn uses shell:true on
        // Windows). A config that fails is dropped, not run (CWE-78).
        .filter((c) => c.port > 0 && isAllowedLauncher(c.exe) && !c.args.some(hasShellMeta));
    } catch {
      return [];
    }
  }

  function portOf(url: string): number {
    try { const u = new URL(url); return Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { return 0; }
  }

  function probe(port: number, timeoutMs = 900): Promise<boolean> {
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

  function stopDevServer(): void {
    const ds = devServer;
    devServer = null;
    if (!ds?.child) return;
    const pid = ds.child.pid;
    try {
      if (process.platform === 'win32' && pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { ds.child.kill('SIGTERM'); } }
      else ds.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  async function ensureApp(opts?: { name?: string; url?: string }): Promise<{ url: string; started: boolean; error?: string; note?: string }> {
    // 1) the caller's current URL already serving? reuse it — but NEVER target the
    // desktop app's OWN dev port (5173): that's this app, not the app under test.
    // The Browser panel defaults to :5173, so a story run must fall through to the
    // workspace's dev config (e.g. the mock on :5174) instead of trying to host 5173.
    // Only honor a caller URL that is LOOPBACK http(s); ignore anything else so
    // an agent can't steer the probe/host at a non-loopback origin.
    const optUrl = opts?.url && isLoopbackHttpSrc(String(opts.url)) ? String(opts.url).trim() : '';
    const rawUrl = (optUrl || session().baseUrl || '').trim();
    const curUrl = portOf(rawUrl) === DESKTOP_PORT ? '' : rawUrl;
    const curPort = portOf(curUrl);

    // Choose the dev config(s) up front so we know which ports are legitimate.
    const configs = readLaunchConfigs().filter((c) => c.port !== DESKTOP_PORT);
    // Only ever probe a KNOWN port — a launch-config port or the session's own
    // base URL — never an arbitrary agent-supplied one (prevents localhost port
    // scanning / local-service reconnaissance, CWE-200).
    const knownPorts = new Set<number>([...configs.map((c) => c.port), portOf(session().baseUrl)].filter((p) => p > 0));
    if (curPort && knownPorts.has(curPort) && (await probe(curPort))) return { url: curUrl || `http://localhost:${curPort}`, started: false };
    let cfg = opts?.name ? configs.find((c) => c.name === opts.name) : undefined;
    if (!cfg && curPort) cfg = configs.find((c) => c.port === curPort);
    if (!cfg) cfg = configs[0];
    if (!cfg) {
      return { url: curUrl, started: false, error: curUrl ? `nothing is serving ${curUrl}, and no .claude/launch.json dev config was found` : 'No app URL set and no .claude/launch.json dev config — set a URL in the Browser panel first.' };
    }
    const url = `http://localhost:${cfg.port}`;

    // 3) already serving on the chosen port? or on a port we already moved to?
    if (await probe(cfg.port)) return { url, started: false };
    if (devServer && devServer.child.exitCode === null && (await probe(devServer.port))) {
      return { url: `http://localhost:${devServer.port}`, started: false };
    }
    // 4) a server we already started still coming up?
    if (devServer && devServer.child.exitCode === null) {
      const u = `http://localhost:${devServer.port}`;
      return (await waitForPort(devServer.port, 20000)) ? { url: u, started: false } : { url: u, started: false, error: `dev server "${cfg.name}" did not become ready on :${devServer.port}` };
    }

    // 5) pick a bindable port — cfg.port if free, else the next free one, and say
    // so (the caller logs `note`), then spawn there and poll until ready.
    stopDevServer();
    let port = cfg.port;
    let note: string | undefined;
    if (!(await isPortFree(cfg.port))) {
      const alt = await findFreePort(cfg.port + 1);
      if (!alt) return { url, started: false, error: `port ${cfg.port} is in use and no free port was found near it` };
      note = `Port ${cfg.port} is in use — starting "${cfg.name}" on ${alt} instead.`;
      port = alt;
    }
    // Runtime guard: never spawn on the desktop app's OWN dev port. The config
    // list is already filtered, but a free-port fallback could still land on it.
    if (port === DESKTOP_PORT) {
      return { url, started: false, error: `refusing to auto-start on :${DESKTOP_PORT} — that's the desktop app's own dev port, not the app under test` };
    }
    const spawnUrl = `http://localhost:${port}`;
    const isWin = process.platform === 'win32';
    const exe = isWin && /^npm$/i.test(cfg.exe) ? 'npm.cmd' : cfg.exe;
    // When we move ports, pass the override to the dev command (npm scripts + vite
    // and friends accept `-- --port <n>`); on the configured port, run it verbatim.
    const args = port === cfg.port ? cfg.args : [...cfg.args, '--', '--port', String(port)];
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd: workspaceRoot, env: { ...process.env }, detached: !isWin, shell: isWin, stdio: 'ignore' });
    } catch (err) {
      return { url: spawnUrl, started: false, error: ipcError(err, `start dev server "${cfg.name}"`) };
    }
    devServer = { child, port };
    child.on('exit', () => { if (devServer?.child === child) devServer = null; });
    const ready = await waitForPort(port, 30000);
    if (!ready) { stopDevServer(); return { url: spawnUrl, started: false, error: `dev server "${cfg.name}" did not become ready on :${port} within 30s` }; }
    return { url: spawnUrl, started: true, note };
  }

  return {
    extract,
    manifest: () => ({ manifest: session().manifest() }),
    getUrl: () => session().baseUrl,
    setUrl: (url) => {
      session().baseUrl = String(url ?? '').trim();
      return { ok: true, url: session().baseUrl };
    },
    runCommand: async (step) => ({ result: await dispatch(session().layer, step) }),
    setDevice: async (device) => ({ result: await session().setDevice(device) }),
    listFlows,
    saveFlow,
    runFlow,
    listStories,
    saveStory,
    saveScreenshot,
    runReport,
    ensureApp,
    stopDriver: async () => {
      await session().close();
      return { ok: true };
    },
    dispose: () => {
      stopDevServer();
      void session().close();
    },
  };
}
