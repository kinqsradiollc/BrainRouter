import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createElectronHarnessEnvironment,
  prepareElectronHarnessLayout,
} from './electron-harness-layout.mjs';

const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 20_000;

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health') return send(response, 200, 'text/plain; charset=utf-8', 'ok');
    if (url.pathname === '/fixture.css') {
      return send(response, 200, 'text/css; charset=utf-8', FIXTURE_CSS, { 'Cache-Control': 'public, max-age=3600, immutable' });
    }
    if (url.pathname === '/fixture.js') {
      return send(response, 200, 'text/javascript; charset=utf-8', FIXTURE_JS, { 'Cache-Control': 'public, max-age=3600, immutable' });
    }
    if (url.pathname === '/download') {
      return send(response, 200, 'text/plain; charset=utf-8', 'brainrouter local fixture download\n', {
        'Content-Disposition': 'attachment; filename="brainrouter-fixture.txt"',
      });
    }
    if (url.pathname === '/popup-target') return send(response, 200, 'text/html; charset=utf-8', fixtureHtml(url, 'Popup target'));
    if (url.pathname === '/' || url.pathname === '/fixture' || url.pathname === '/history') {
      const label = url.pathname === '/history' ? `History ${url.searchParams.get('step') || '0'}` : `Fixture ${url.searchParams.get('id') || '0'}`;
      return send(response, 200, 'text/html; charset=utf-8', fixtureHtml(url, label));
    }
    send(response, 404, 'text/plain; charset=utf-8', 'not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    externalNetwork: false,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function fixtureHtml(url, label) {
  const safeLabel = escapeHtml(label);
  const id = escapeHtml(url.searchParams.get('id') || '0');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeLabel}</title>
  <link rel="stylesheet" href="/fixture.css">
  <script src="/fixture.js" defer></script>
</head>
<body data-fixture-id="${id}">
  <header><h1 data-testid="fixture-heading">${safeLabel}</h1></header>
  <main>
    <p>This page is served only from the benchmark's loopback fixture.</p>
    <a data-testid="history-one" href="/history?step=1">History one</a>
    <a data-testid="history-two" href="/history?step=2">History two</a>
    <a data-testid="popup-link" href="/popup-target?from=${id}" target="_blank" rel="opener">Open popup tab</a>
    <a data-testid="download-link" href="/download">Download fixture</a>
    <div class="spacer" aria-hidden="true"></div>
    <label for="retained-input">Retained value</label>
    <input id="retained-input" data-testid="retained-input" autocomplete="off" value="">
    <output data-testid="scroll-state" aria-live="polite">scroll:0</output>
    <button data-testid="interaction-button" type="button">Measure interaction</button>
  </main>
</body>
</html>`;
}

const FIXTURE_CSS = `
html { font: 16px system-ui, sans-serif; background: #fff; color: #111; }
body { margin: 0; }
header, main { max-width: 760px; margin: 0 auto; padding: 24px; }
a { display: inline-block; margin: 8px 16px 8px 0; }
.spacer { height: 1400px; background: linear-gradient(#f5f5f5, #fff); }
label, input, output, button { display: block; margin: 12px 0; }
input { width: 320px; padding: 8px; }
`;

const FIXTURE_JS = `
(() => {
  const metrics = { lcpMs: null, cls: 0, inpMs: null, longTasks: [] };
  window.__brainrouterFixtureMetrics = metrics;
  const observe = (type, callback) => {
    try { const observer = new PerformanceObserver((list) => callback(list.getEntries())); observer.observe({ type, buffered: true }); } catch {}
  };
  observe('largest-contentful-paint', (entries) => { const last = entries.at(-1); if (last) metrics.lcpMs = last.startTime; });
  observe('layout-shift', (entries) => { for (const entry of entries) if (!entry.hadRecentInput) metrics.cls += entry.value; });
  observe('event', (entries) => { for (const entry of entries) metrics.inpMs = Math.max(metrics.inpMs || 0, entry.duration || 0); });
  observe('longtask', (entries) => { metrics.longTasks.push(...entries.map((entry) => entry.duration)); });
  const output = document.querySelector('[data-testid="scroll-state"]');
  const updateScroll = () => {
    const scroll = Math.round(window.scrollY);
    if (output) output.textContent = 'scroll:' + scroll;
    document.title = document.title.replace(/ scroll:\\d+$/, '') + ' scroll:' + scroll;
  };
  window.addEventListener('scroll', updateScroll, { passive: true });
  document.querySelector('[data-testid="interaction-button"]')?.addEventListener('click', () => {
    document.body.dataset.interacted = 'true';
  });
  window.__brainrouterFixtureReady = true;
})();
`;

function send(response, status, contentType, body, headers = {}) {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'Cache-Control': headers['Cache-Control'] || 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(bytes);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export class CdpSession {
  constructor(webSocketDebuggerUrl, label = 'DevTools target') {
    this.label = label;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = new Set();
    this.opened = new Promise((resolve, reject) => {
      this.socket = new WebSocket(webSocketDebuggerUrl);
      const timer = setTimeout(() => reject(new Error(`${label} DevTools connection timed out`)), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`${label} DevTools connection failed`)); }, { once: true });
      this.socket.addEventListener('message', (event) => this.onMessage(event));
      this.socket.addEventListener('close', () => this.rejectPending(new Error(`${label} DevTools connection closed`)));
    });
  }

  async request(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    await this.opened;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = COMMAND_TIMEOUT_MS, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${this.label} ${method} event timed out`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async evaluate(expression, timeoutMs = COMMAND_TIMEOUT_MS) {
    const result = await this.request('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || `${this.label} evaluation failed`);
    }
    return result?.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* already closed */ }
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export async function launchElectron({ desktopRoot, electronApp = '' }) {
  const launch = resolveElectronLaunch(desktopRoot, electronApp);
  const port = await reservePort();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-browser-e2e-'));
  const layout = prepareElectronHarnessLayout(temporaryRoot);
  const { profile, workspace } = layout;
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-background-networking',
    ...launch.args,
  ];
  const environment = createElectronHarnessEnvironment(layout);
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.BRAINROUTER_UPDATE_CHANNEL;
  const processHandle = spawnManaged(launch.executable, args, { cwd: workspace, env: environment, label: 'Electron' });
  try {
    const endpoint = await waitForDevTools(port, processHandle);
    const renderer = await waitForElectronBridge(port, processHandle);
    return {
      kind: 'electron',
      name: 'BrainRouter Electron',
      launch: launch.description,
      port,
      pid: processHandle.child.pid,
      version: endpoint.version,
      renderer,
      processHandle,
      temporaryRoot,
      async evaluate(expression, timeoutMs) { return renderer.evaluate(expression, timeoutMs); },
      async stop() {
        renderer.close();
        await processHandle.stop();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await processHandle.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export function findInstalledBrowser(explicitPath = '') {
  const candidates = [];
  if (explicitPath) candidates.push({ name: browserName(explicitPath), path: explicitPath });
  if (process.env.BRAINROUTER_COMPARE_BROWSER) candidates.push({ name: browserName(process.env.BRAINROUTER_COMPARE_BROWSER), path: process.env.BRAINROUTER_COMPARE_BROWSER });
  if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    );
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        { name: 'Google Chrome', path: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        { name: 'Microsoft Edge', path: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      );
    }
  } else {
    for (const executable of ['google-chrome-stable', 'google-chrome', 'microsoft-edge-stable', 'microsoft-edge']) {
      const resolved = resolveOnPath(executable);
      if (resolved) candidates.push({ name: browserName(resolved), path: resolved });
    }
  }
  return candidates.find((candidate) => candidate.path && fs.existsSync(candidate.path)) ?? null;
}

export async function launchComparisonBrowser({ browserPath = '', initialUrl }) {
  const browser = findInstalledBrowser(browserPath);
  if (!browser) return null;
  const port = await reservePort();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-browser-compare-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(temporaryRoot, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--new-window',
    initialUrl,
  ];
  const processHandle = spawnManaged(browser.path, args, { cwd: temporaryRoot, env: process.env, label: browser.name });
  try {
    const endpoint = await waitForDevTools(port, processHandle);
    const browserSession = new CdpSession(endpoint.version.webSocketDebuggerUrl, `${browser.name} browser`);
    const page = await waitForPageTarget(port, processHandle, (target) => target.url?.startsWith(initialUrl));
    const pageSession = new CdpSession(page.webSocketDebuggerUrl, `${browser.name} page`);
    await pageSession.request('Page.enable');
    await pageSession.request('Runtime.enable');
    return {
      kind: 'comparison-browser',
      name: browser.name,
      executable: browser.path,
      port,
      pid: processHandle.child.pid,
      version: endpoint.version,
      browserSession,
      pageSession,
      pageTargetId: page.id,
      processHandle,
      temporaryRoot,
      async stop() {
        pageSession.close();
        browserSession.close();
        await processHandle.stop();
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await processHandle.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function runRendererProgram(electron, program, args = {}, timeoutMs = 120_000) {
  const expression = `(${program.toString()})(${JSON.stringify(args)})`;
  return electron.evaluate(expression, timeoutMs);
}

export async function navigateChrome(pageSession, url) {
  const loaded = pageSession.waitForEvent('Page.loadEventFired');
  const started = performance.now();
  const result = await pageSession.request('Page.navigate', { url });
  if (result?.errorText) throw new Error(`Chrome navigation failed: ${result.errorText}`);
  await loaded;
  return performance.now() - started;
}

export async function createChromeTab(browserSession, url) {
  const started = performance.now();
  const result = await browserSession.request('Target.createTarget', { url, background: true });
  if (!result?.targetId) throw new Error('Chrome did not return a target id for the new tab');
  return { targetId: result.targetId, durationMs: performance.now() - started };
}

export async function closeChromeTab(browserSession, targetId) {
  await browserSession.request('Target.closeTarget', { targetId });
}

export async function processTreeSample(rootPid, { samples = 1, intervalMs = 250 } = {}) {
  if (process.platform === 'win32') return { supported: false, reason: 'process-tree RSS/CPU sampler is not implemented on Windows' };
  const readings = [];
  for (let index = 0; index < samples; index += 1) {
    readings.push(readPsTree(rootPid));
    if (index + 1 < samples) await delay(intervalMs);
  }
  const valid = readings.filter((entry) => entry.processCount > 0);
  if (!valid.length) return { supported: false, reason: `no live processes found below pid ${rootPid}` };
  return {
    supported: true,
    processCount: Math.max(...valid.map((entry) => entry.processCount)),
    rssBytes: Math.round(valid.reduce((sum, entry) => sum + entry.rssBytes, 0) / valid.length),
    cpuPercent: valid.reduce((sum, entry) => sum + entry.cpuPercent, 0) / valid.length,
  };
}

export function chromiumMajor(versionObject) {
  const browser = String(versionObject?.Browser || versionObject?.browser || '');
  const match = /(?:Chrome|Chromium)\/(\d+)\./i.exec(browser);
  return match ? Number(match[1]) : null;
}

export async function listDevToolsTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools target list returned HTTP ${response.status}`);
  return response.json();
}

function resolveElectronLaunch(desktopRoot, explicit) {
  if (explicit) {
    const executable = executableFromApp(explicit);
    return { executable, args: [], description: explicit };
  }
  const main = path.join(desktopRoot, 'dist-electron', 'main.js');
  const renderer = path.join(desktopRoot, 'dist', 'index.html');
  if (!fs.existsSync(main) || !fs.existsSync(renderer)) {
    throw new Error('BrainRouter desktop build is missing; run `npm run build -w brainrouter-desktop` first');
  }
  const electronRoots = [
    path.join(desktopRoot, 'node_modules', 'electron', 'dist'),
    path.join(desktopRoot, '..', 'node_modules', 'electron', 'dist'),
  ];
  const executableFor = (electronBase) => process.platform === 'darwin'
    ? path.join(electronBase, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? path.join(electronBase, 'electron.exe')
      : path.join(electronBase, 'electron');
  const executable = electronRoots.map(executableFor).find((candidate) => fs.existsSync(candidate)) || executableFor(electronRoots[0]);
  if (!fs.existsSync(executable)) throw new Error('Electron runtime is missing; run `npm install` from the repository root');
  return { executable, args: [desktopRoot], description: `development build at ${desktopRoot}` };
}

function executableFromApp(candidate) {
  if (process.platform !== 'darwin' || !candidate.endsWith('.app')) return candidate;
  const macos = path.join(candidate, 'Contents', 'MacOS');
  if (!fs.existsSync(macos)) throw new Error(`${candidate} has no Contents/MacOS directory`);
  const files = fs.readdirSync(macos).map((entry) => path.join(macos, entry)).filter((entry) => fs.statSync(entry).isFile());
  const preferred = files.find((entry) => path.basename(entry) === path.basename(candidate, '.app'));
  if (!preferred && !files[0]) throw new Error(`${candidate} contains no executable`);
  return preferred || files[0];
}

function spawnManaged(executable, args, { cwd, env, label }) {
  let output = '';
  let launchError = null;
  const detached = process.platform !== 'win32';
  const child = spawn(executable, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-12_000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', (error) => { launchError = error; });
  return {
    child,
    label,
    logs: () => output ? `\n--- ${label} output ---\n${output}` : '',
    assertRunning() {
      if (launchError) throw new Error(`${label} failed to launch: ${launchError.message}${this.logs()}`);
      if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode}${this.logs()}`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      killManaged(child, 'SIGTERM', detached);
      if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
      killManaged(child, 'SIGKILL', detached);
      await Promise.race([exited, delay(2_000)]);
    },
  };
}

function killManaged(child, signal, detached) {
  try {
    if (detached && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* already stopped */ }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a DevTools port');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForDevTools(port, managed) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    managed.assertRunning();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const version = await response.json();
        if (version?.webSocketDebuggerUrl) return { version };
      }
    } catch { /* renderer has not exposed DevTools yet */ }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${managed.label} DevTools${managed.logs()}`);
}

async function waitForElectronBridge(port, managed) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    managed.assertRunning();
    let targets = [];
    try { targets = await listDevToolsTargets(port); } catch { /* retry */ }
    for (const target of targets) {
      if (target?.type !== 'page' || !target.webSocketDebuggerUrl) continue;
      const session = new CdpSession(target.webSocketDebuggerUrl, 'BrainRouter renderer');
      try {
        const ready = await session.evaluate("Boolean(globalThis.brainrouter && globalThis.brainrouter.browser && typeof globalThis.brainrouter.browser.command === 'function')", 3_000);
        if (ready) return session;
      } catch { /* native browser pages do not own the preload bridge */ }
      session.close();
    }
    await delay(150);
  }
  throw new Error(`BrainRouter renderer did not expose the browser bridge${managed.logs()}`);
}

async function waitForPageTarget(port, managed, predicate) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    managed.assertRunning();
    try {
      const targets = await listDevToolsTargets(port);
      const target = targets.find((entry) => entry?.type === 'page' && entry.webSocketDebuggerUrl && predicate(entry));
      if (target) return target;
    } catch { /* retry */ }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${managed.label} page target${managed.logs()}`);
}

function readPsTree(rootPid) {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], { encoding: 'utf8' });
  const rows = output.split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuPercent: Number(match[4]), command: match[5] };
  }).filter(Boolean);
  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter((row) => descendants.has(row.pid));
  return {
    processCount: selected.length,
    rssBytes: selected.reduce((sum, row) => sum + row.rssKiB * 1024, 0),
    cpuPercent: selected.reduce((sum, row) => sum + row.cpuPercent, 0),
  };
}

function resolveOnPath(executable) {
  try { return execFileSync('which', [executable], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

function browserName(executable) {
  return /edge|msedge/i.test(executable) ? 'Microsoft Edge' : 'Google Chrome';
}
