/**
 * BROWSER HOST (Desktop side) — the host-side glue for the "Browser" panel. It
 * owns the workspace walk + incremental `data-testid` extraction (re-parse only
 * changed files) and persists the manifest; the driver, base URL, command layer,
 * and manifest sharing remain in the package's shared session. Live page control
 * is now routed separately to the window-owned WebContentsView manager; this host
 * never launches a production Playwright/Chrome process.
 *
 * Imports the headless engine the same way host.ts imports the CLI runtime —
 * a deep import into the built package (resolved via the workspace symlink).
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
} from '@kinqs/brainrouter-core/browser';
import { shouldIgnoreWatchPath } from './fileWatch.js';
// IPC is agent-reachable — names + extract paths it receives are untrusted.
import { safeName, isPathWithinRoot, mdSafe } from './browserSafety.js';
import { isLoopbackHttpSrc } from './webviewPolicy.js';
// The dev-server registry owns spawning/tracking launch.json servers; the story
// auto-host (ensureApp) delegates the actual start to it and only keeps the
// story-specific pre-checks. `probe`/`portOf` are its pure helpers.
import { DESKTOP_PORT, portOf, probe, type DevServerRegistry } from './devServerRegistry.js';

/**
 * The `browser:*` channel is agent-reachable — log the full error to the dev
 * console but return a GENERIC message across IPC so fs paths / env / stack
 * traces don't leak to the caller (CWE-209).
 */
function ipcError(err: unknown, what: string): string {
  console.error(`[browser] ${what} failed:`, err);
  return `${what} failed`;
}

const SOURCE_RE = /\.[jt]sx?$/i;
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;
const MAX_BROWSER_SHOT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_SCREENSHOTS = 50;
const MAX_REPORT_RESULTS = 1_000;
const MAX_REPORT_MARKDOWN_BYTES = 2 * 1024 * 1024;

function canonicalInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Write a bounded workspace artifact without following a pre-existing symlink
 * in any controlled directory or at the final filename. Replacement writes use
 * an exclusive temporary file and atomic rename so a planted final symlink is
 * replaced as a directory entry rather than followed.
 */
function writeWorkspaceArtifact(
  workspaceRoot: string,
  relativeFile: string,
  data: string | Buffer,
  replace: boolean,
): { absolute: string; relative: string } {
  const normalized = relativeFile.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..') || path.posix.isAbsolute(normalized)) {
    throw new Error('unsafe workspace artifact path');
  }
  const root = fs.realpathSync(workspaceRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('workspace is not a directory');
  let parent = root;
  for (const segment of parts.slice(0, -1)) {
    const candidate = path.join(parent, segment);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { fs.mkdirSync(candidate, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = fs.lstatSync(candidate);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe workspace artifact directory');
    const canonical = fs.realpathSync(candidate);
    if (!canonicalInside(root, canonical) || path.dirname(canonical) !== parent) throw new Error('workspace artifact escaped its root');
    parent = canonical;
  }
  const filename = parts.at(-1)!;
  const target = path.join(parent, filename);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const writeExclusive = (file: string): void => {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
  if (replace) {
    const temporary = path.join(parent, `.${filename}.${randomUUID()}.tmp`);
    try {
      writeExclusive(temporary);
      try {
        const current = fs.lstatSync(target);
        if (current.isSymbolicLink() || !current.isFile()) throw new Error('unsafe workspace artifact target');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      fs.renameSync(temporary, target);
    } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
  } else {
    writeExclusive(target);
  }
  const final = fs.realpathSync(target);
  if (!canonicalInside(root, final) || path.dirname(final) !== parent) throw new Error('workspace artifact escaped after write');
  return { absolute: final, relative: path.relative(root, final).split(path.sep).join('/') };
}

/** A single panel/agent request: an element action (target = element id) or a
 *  navigate (target = screen id). Mirrors the package's FlowStep. */
export interface BrowserStep {
  action: 'navigate' | 'tap' | 'type' | 'assertVisible';
  target: string;
  text?: string;
}

/** One executed story step's outcome, captured live in the Browser panel. */
export interface BrowserStepResult {
  i: number;
  action: string;
  target: string;
  ok: boolean;
  error?: string;
  ms?: number;
}

/** A captured screenshot handed back from the Browser panel (data URL / base64). */
export interface BrowserShot {
  name: string;
  dataUrl: string;
}

/** A finished story run to turn into a markdown report. */
export interface BrowserRunReportInput {
  story: { id?: string; title?: string };
  baseUrl?: string;
  results: BrowserStepResult[];
  screenshots?: BrowserShot[];
}

export interface BrowserHost {
  /** Full workspace walk, or (with `only`) re-extract just those files and merge
   *  into the existing map. `broad` also captures interactive elements without
   *  data-testid (the whole-app map); toggling it re-extracts from scratch. */
  extract(opts?: { only?: string[]; broad?: boolean }): { manifest: UiMap; diff: ManifestDiff; degraded: boolean; fileCount: number };
  manifest(): { manifest: UiMap | null };
  setUrl(url: string): { ok: boolean; url: string };
  getUrl(): string;
  runCommand(step: BrowserStep): Promise<{ result: UiCommandResult }>;
  setDevice(device: Device): Promise<{ result: UiCommandResult }>;
  listFlows(): { flows: string[] };
  saveFlow(name: string, steps: BrowserStep[]): { ok: boolean; name: string; error?: string };
  runFlow(arg: { name?: string; steps?: BrowserStep[] }): Promise<{ results: UiCommandResult[] }>;
  /** Saved user-journey stories (`.brainrouter/ui-tests/stories/*.story.yaml`). */
  listStories(): { stories: Story[] };
  saveStory(story: Story): { ok: boolean; id: string; error?: string };
  /** Persist a captured screenshot (data URL / base64) under
   *  `.brainrouter/ui-tests/screenshots/`; returns its workspace-relative path. */
  saveScreenshot(opts: { dataUrl?: string; base64?: string; name?: string }): { path?: string; error?: string };
  /** Build a markdown run report (saving its screenshots) under
   *  `.brainrouter/ui-tests/reports/`; the host then registers it as an Artifact. */
  runReport(input: BrowserRunReportInput): { reportPath?: string; markdown?: string; screenshots?: string[]; error?: string };
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

async function dispatch(layer: CommandLayer, step: BrowserStep): Promise<UiCommandResult> {
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

export function createBrowserHost(workspaceRoot: string, devServers: DevServerRegistry): BrowserHost {
  // In-memory incremental state: re-parse only files whose hash changed.
  const fileSites = new Map<string, FileSites>();
  const hashes = new Map<string, string>();
  let lastBroad: boolean | undefined; // extraction mode the cache was built in
  const session = () => getUiTestSession(workspaceRoot);

  function writeManifest(m: UiMap): void {
    try {
      const p = manifestPathFor(workspaceRoot);
      writeWorkspaceArtifact(workspaceRoot, path.relative(workspaceRoot, p), JSON.stringify(m, null, 2) + '\n', true);
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

  function saveFlow(name: string, steps: BrowserStep[]): { ok: boolean; name: string; error?: string } {
    try {
      const safe = sanitizeFlowName(name);
      const yaml = serializeFlowYaml({ name: safe, steps: steps as never });
      writeWorkspaceArtifact(workspaceRoot, `.brainrouter/ui-tests/flows/${safe}.flow.yaml`, yaml, true);
      return { ok: true, name: safe };
    } catch (err) {
      return { ok: false, name, error: ipcError(err, 'save flow') };
    }
  }

  async function runFlow(arg: { name?: string; steps?: BrowserStep[] }): Promise<{ results: UiCommandResult[] }> {
    let steps: BrowserStep[] = [];
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
      writeWorkspaceArtifact(workspaceRoot, `.brainrouter/ui-tests/stories/${safe}.story.yaml`, serializeStoryYaml({ ...story, id: safe }), true);
      return { ok: true, id: safe };
    } catch (err) {
      return { ok: false, id: story.id, error: ipcError(err, 'save story') };
    }
  }

  // --- Screenshots + run reports -------------------------------------------
  const stamp = (): string => new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').replace('Z', '');
  const mdCell = (s: string | undefined): string => String(s ?? '').slice(0, 4_096).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  function decodePng(data: string): Buffer | null {
    const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/i.exec(data);
    const b64 = m ? m[1] : data;
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
    try {
      const buf = Buffer.from(b64, 'base64');
      return buf.length > 0 && buf.length <= MAX_BROWSER_SHOT_BYTES ? buf : null;
    } catch { return null; }
  }

  function saveScreenshot(opts: { dataUrl?: string; base64?: string; name?: string }): { path?: string; error?: string } {
    const buf = decodePng(String(opts.dataUrl ?? opts.base64 ?? ''));
    if (!buf) return { error: 'no image data to save' };
    try {
      const file = `${sanitizeFlowName(opts.name || 'shot')}-${stamp()}-${randomUUID().slice(0, 8)}.png`;
      const stored = writeWorkspaceArtifact(workspaceRoot, `.brainrouter/ui-tests/screenshots/${file}`, buf, false);
      return { path: stored.relative };
    } catch (err) {
      return { error: ipcError(err, 'save screenshot') };
    }
  }

  function buildReportMarkdown(a: { title: string; id: string; baseUrl?: string; results: BrowserStepResult[]; shotPaths: string[]; passed: number }): string {
    const total = a.results.length;
    const allOk = total > 0 && a.passed === total;
    const lines: string[] = [];
    // title / id / baseUrl are agent-supplied (browser:run-report) — HTML-encode
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

  function runReport(input: BrowserRunReportInput): { reportPath?: string; markdown?: string; screenshots?: string[]; error?: string } {
    try {
      const results = Array.isArray(input.results) ? input.results.slice(0, MAX_REPORT_RESULTS) : [];
      const title = (String(input.story?.title ?? '').trim()) || 'UI run';
      const id = sanitizeFlowName(input.story?.id || title);
      // 1) persist screenshots alongside the report, collect relative paths.
      const shotPaths: string[] = [];
      for (const s of (input.screenshots ?? []).slice(0, MAX_REPORT_SCREENSHOTS)) {
        const r = saveScreenshot({ dataUrl: s.dataUrl, name: `${id}-${s.name || 'shot'}` });
        if (r.path) shotPaths.push(r.path);
      }
      // 2) build + write the markdown.
      const passed = results.filter((r) => r.ok).length;
      const md = buildReportMarkdown({ title, id, baseUrl: input.baseUrl, results, shotPaths, passed });
      if (Buffer.byteLength(md, 'utf8') > MAX_REPORT_MARKDOWN_BYTES) throw new Error('run report exceeded its size limit');
      const stored = writeWorkspaceArtifact(
        workspaceRoot,
        `.brainrouter/ui-tests/reports/${id}-${stamp()}-${randomUUID().slice(0, 8)}.md`,
        md,
        false,
      );
      return { reportPath: stored.relative, markdown: md, screenshots: shotPaths };
    } catch (err) {
      return { error: ipcError(err, 'save run report') };
    }
  }

  // --- Auto-host: probe the app URL, else DELEGATE the dev-server start to the
  // shared registry (which owns spawning/tracking/port-fallback + every guard).
  // This keeps the STORY-run pre-checks here (reuse the current loopback URL, skip
  // the desktop's own :5173, only probe KNOWN ports) and hands the spawn to the
  // registry so the Servers panel and story runs drive the same processes.
  async function ensureApp(opts?: { name?: string; url?: string }): Promise<{ url: string; started: boolean; error?: string; note?: string }> {
    // 1) the caller's current URL already serving? reuse it — but NEVER target the
    // desktop app's OWN dev port (5173): that's this app, not the app under test.
    // Only honor a caller URL that is LOOPBACK http(s); ignore anything else so
    // an agent can't steer the probe/host at a non-loopback origin.
    const optUrl = opts?.url && isLoopbackHttpSrc(String(opts.url)) ? String(opts.url).trim() : '';
    const rawUrl = (optUrl || session().baseUrl || '').trim();
    const curUrl = portOf(rawUrl) === DESKTOP_PORT ? '' : rawUrl;
    const curPort = portOf(curUrl);

    // Choose the dev config(s) up front so we know which ports are legitimate.
    const configs = devServers.list().filter((c) => c.port !== DESKTOP_PORT);
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

    // 2) delegate the actual probe/port-fallback/spawn/wait to the registry.
    const status = await devServers.start(cfg.name);
    const url = status.url || `http://localhost:${cfg.port}`;
    if (status.error) return { url, started: false, error: status.error, note: status.note };
    return { url, started: !!status.started, note: status.note };
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
      // Dev servers are owned by the shared registry (host.ts disposes it on quit).
      void session().close();
    },
  };
}
