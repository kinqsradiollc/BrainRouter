#!/usr/bin/env node
/**
 * CP-B — packaged-build verification.
 *
 * Runs against an electron-builder output to assert the bits that determine
 * whether native computer-use and the first-class browser work in the shipped app:
 *   1. a per-arch installer (.dmg / .zip) was produced;
 *   2. the libnut native module is UNPACKED from the asar (asarUnpack), so the
 *      `.node` binary is loadable at runtime (a packed .node can't be dlopen'd);
 *   3. Electron's package/build pins agree on the approved Chromium runtime;
 *   4. the packaged app exposes the native browser bridge, creates two distinct
 *      tabs, and executes a state command against that same browser manager;
 *   5. (macOS, advisory) the .app is code-signed with a Developer ID and the
 *      hardened-runtime entitlements are embedded.
 *
 * The structural/runtime checks (1–4) FAIL the build; signing/notarization (5) is
 * advisory because the same pipeline runs without credentials (un-signed) to
 * verify itself. The final interactive step — granting Accessibility + Screen
 * Recording and watching the app drive a real click — is a human acceptance on
 * macOS hardware (TCC can't be granted non-interactively); it's printed below.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const OUT_DIRS = ['dist', 'release', 'out'].map((d) => path.join(root, d));
const EXPECTED_ELECTRON_VERSION = '43.1.1';
const EXPECTED_CHROMIUM_MAJOR = 150;
const PACKAGED_SMOKE_TIMEOUT_MS = 30_000;

function walk(dir, pred, hits = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return hits;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (pred(p, e)) hits.push(p);
    if (e.isDirectory() && !e.name.endsWith('.app')) walk(p, pred, hits, depth + 1);
  }
  return hits;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a DevTools port');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function packagedExecutable(app) {
  const macos = path.join(app, 'Contents', 'MacOS');
  if (!fs.existsSync(macos)) throw new Error(`${path.basename(app)} has no Contents/MacOS executable directory`);
  const candidates = fs.readdirSync(macos)
    .map((name) => path.join(macos, name))
    .filter((candidate) => fs.statSync(candidate).isFile());
  const executable = candidates.find((candidate) => path.basename(candidate) === path.basename(app, '.app'))
    ?? candidates[0];
  if (!executable) throw new Error(`${path.basename(app)} contains no executable`);
  return executable;
}

function selectRunnableApp(apps) {
  const unique = [...new Set(apps)];
  const archMatch = process.arch === 'arm64'
    ? unique.filter((app) => /(?:^|[/\\])mac-arm64(?:[/\\]|$)/i.test(app))
    : unique.filter((app) => /(?:^|[/\\])mac(?:[/\\]|$)/i.test(app) && !/arm64/i.test(app));
  const candidates = archMatch.length ? archMatch : unique;
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function waitForDevTools(port, child, logs, launchError) {
  const deadline = Date.now() + PACKAGED_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (launchError()) throw new Error(`could not launch the packaged app: ${launchError().message}${logs()}`);
    if (child.exitCode !== null) {
      throw new Error(`packaged app exited with code ${child.exitCode} before browser smoke started${logs()}`);
    }
    try {
      const [versionResponse, targetsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/json/version`),
        fetch(`http://127.0.0.1:${port}/json/list`),
      ]);
      if (versionResponse.ok && targetsResponse.ok) {
        const version = await versionResponse.json();
        const targets = await targetsResponse.json();
        if (Array.isArray(targets) && targets.length > 0) return { version, targets };
      }
    } catch {
      // The DevTools endpoint appears after Electron creates its first renderer.
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for the packaged app DevTools endpoint${logs()}`);
}

async function evaluateCdp(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools evaluation timed out'));
    }, 10_000);
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('could not connect to the packaged renderer DevTools target'));
    }, { once: true });
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    }, { once: true });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) {
        reject(new Error(message.error.message || 'DevTools evaluation failed'));
        return;
      }
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description || 'renderer evaluation threw'));
        return;
      }
      resolve(message.result?.result?.value);
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill('SIGKILL');
  await Promise.race([exited, delay(2_000)]);
}

async function runPackagedBrowserSmoke(app) {
  const executable = packagedExecutable(app);
  const port = await reservePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-packaged-browser-'));
  const workspace = path.join(tempRoot, 'workspace');
  const profile = path.join(tempRoot, 'profile');
  fs.mkdirSync(workspace, { recursive: true });
  const childEnv = { ...process.env, BRAINROUTER_DESKTOP_WORKSPACE: workspace };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Build-only Node flags inherited from CI are rejected by packaged Electron
  // and can prevent the application from reaching its first renderer.
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITE_DEV_SERVER_URL;
  let output = '';
  let launchError = null;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
  ], {
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', (error) => { launchError = error; });
  const logs = () => output ? `\n--- packaged app output ---\n${output}` : '';
  try {
    const { version } = await waitForDevTools(port, child, logs, () => launchError);
    const browserVersion = typeof version?.Browser === 'string' ? version.Browser : '';
    const chromiumMatch = /(?:Chrome|Chromium)\/(\d+)\./.exec(browserVersion);
    if (!chromiumMatch || Number(chromiumMatch[1]) !== EXPECTED_CHROMIUM_MAJOR) {
      throw new Error(`packaged runtime reported ${browserVersion || 'no Chromium version'}; expected Chromium ${EXPECTED_CHROMIUM_MAJOR}`);
    }

    const expression = `(async () => {
      const api = globalThis.brainrouter && globalThis.brainrouter.browser;
      if (!api || typeof api.getState !== 'function' || typeof api.command !== 'function') {
        return { bridge: false };
      }
      const initial = await api.getState();
      const first = await api.command({ op: 'create-tab', url: 'about:blank', active: true });
      const second = await api.command({ op: 'create-tab', url: 'about:blank', active: true });
      const command = await api.command({ op: 'state' });
      const finalState = await api.getState();
      return {
        bridge: true,
        initialCount: Array.isArray(initial && initial.tabs) ? initial.tabs.length : -1,
        finalCount: Array.isArray(finalState && finalState.tabs) ? finalState.tabs.length : -1,
        firstOk: first && first.ok === true,
        secondOk: second && second.ok === true,
        commandOk: command && command.ok === true,
        firstId: first && first.value && first.value.id,
        secondId: second && second.value && second.value.id,
        nativeTabs: finalState && finalState.capabilities && finalState.capabilities.nativeTabs === true,
        sameVisibleTabAutomation: finalState && finalState.capabilities && finalState.capabilities.sameVisibleTabAutomation === true,
        userAgent: navigator.userAgent,
      };
    })()`;

    let smoke = null;
    const bridgeDeadline = Date.now() + PACKAGED_SMOKE_TIMEOUT_MS;
    while (!smoke && Date.now() < bridgeDeadline) {
      if (launchError) throw new Error(`packaged app launch failed: ${launchError.message}${logs()}`);
      if (child.exitCode !== null) throw new Error(`packaged app exited before its browser bridge became ready${logs()}`);
      let targets = [];
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (response.ok) targets = await response.json();
      } catch {
        // Retry while the packaged renderer starts.
      }
      const pageTargets = Array.isArray(targets)
        ? targets.filter((target) => target?.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
        : [];
      for (const target of pageTargets) {
        try {
          const result = await evaluateCdp(target.webSocketDebuggerUrl, expression);
          if (result?.bridge) { smoke = result; break; }
        } catch {
          // Browser WebContentsViews are also page targets; only the app
          // renderer owns the preload bridge, so probe targets until it appears.
        }
      }
      if (!smoke) await delay(200);
    }
    if (!smoke) throw new Error(`packaged app renderer did not expose the browser bridge${logs()}`);
    if (!smoke.firstOk || !smoke.secondOk || !smoke.commandOk) {
      throw new Error(`packaged browser command failed: ${JSON.stringify(smoke)}`);
    }
    if (smoke.finalCount < smoke.initialCount + 2 || !smoke.firstId || !smoke.secondId || smoke.firstId === smoke.secondId) {
      throw new Error(`packaged browser did not create two distinct tabs: ${JSON.stringify(smoke)}`);
    }
    if (!smoke.nativeTabs || !smoke.sameVisibleTabAutomation) {
      throw new Error(`packaged browser capabilities are incomplete: ${JSON.stringify(smoke)}`);
    }
    console.log(
      `✓ ${path.basename(app)}: Chromium ${EXPECTED_CHROMIUM_MAJOR} browser bridge created two tabs and executed a state command`,
    );
  } finally {
    await stopChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const outDirs = OUT_DIRS.filter((d) => fs.existsSync(d));
if (!outDirs.length) {
  console.error(
    `✗ no build output found (looked in: ${OUT_DIRS.map((d) => path.relative(root, d)).join(', ')}). Run \`npm run dist:mac\` first.`,
  );
  process.exit(1);
}

const errors = [];
const warnings = [];

// 0) source metadata: the development runtime and electron-builder must package
// the exact same Electron release so CI cannot silently test one Chromium and
// ship another.
try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const devVersion = packageJson.devDependencies?.electron;
  const buildVersion = packageJson.build?.electronVersion;
  if (devVersion === EXPECTED_ELECTRON_VERSION && buildVersion === EXPECTED_ELECTRON_VERSION) {
    console.log(`✓ Electron ${EXPECTED_ELECTRON_VERSION} is pinned consistently for development and packaging`);
  } else {
    errors.push(
      `Electron version mismatch: devDependencies.electron=${String(devVersion)}, build.electronVersion=${String(buildVersion)}, expected ${EXPECTED_ELECTRON_VERSION}`,
    );
  }
} catch (error) {
  errors.push(`could not validate Electron package metadata: ${error instanceof Error ? error.message : String(error)}`);
}

// 1) installers
const installers = outDirs.flatMap((dir) => walk(dir, (p) => /\.(dmg|zip)$/i.test(p)));
if (installers.length)
  console.log(`✓ ${installers.length} installer(s): ${installers.map((p) => path.basename(p)).join(', ')}`);
else errors.push('no .dmg/.zip installer produced');

// 2) the app bundle + unpacked native module
const apps = outDirs.flatMap((dir) => walk(dir, (p, e) => e.isDirectory() && p.endsWith('.app')));
if (!apps.length) {
  errors.push('no .app bundle found in the output');
} else {
  for (const app of apps) {
    const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
    const nodeFiles = fs.existsSync(unpacked) ? walk(unpacked, (p) => p.endsWith('.node')) : [];
    const libnut = nodeFiles.some((p) => /libnut/i.test(p));
    const nodePty = nodeFiles.some((p) => /node-pty|pty\.node/i.test(p));
    if (libnut)
      console.log(`✓ ${path.basename(app)}: libnut native module unpacked (${nodeFiles.length} .node file(s))`);
    else
      errors.push(
        `${path.basename(app)}: libnut .node not found under app.asar.unpacked — computer-use would fail at runtime`,
      );
    if (nodePty) console.log(`✓ ${path.basename(app)}: node-pty native module unpacked`);
    else
      errors.push(
        `${path.basename(app)}: node-pty .node not found under app.asar.unpacked — interactive terminals would fail at runtime`,
      );

    // 3) signing + entitlements (advisory)
    if (process.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
        console.log(`✓ ${path.basename(app)}: code signature valid`);
        const ent = execFileSync('codesign', ['-d', '--entitlements', ':-', app], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (/screen-recording|automation|disable-library-validation|com\.apple\.security/.test(ent))
          console.log(`✓ ${path.basename(app)}: hardened-runtime entitlements embedded`);
        else
          warnings.push(
            `${path.basename(app)}: entitlements look minimal — confirm Accessibility + Screen Recording are present`,
          );
      } catch {
        warnings.push(
          `${path.basename(app)}: not code-signed (expected for a credential-less pipeline run; a release build must set CSC_LINK + APPLE_* secrets)`,
        );
      }
    }
  }
}

// 4) Real packaged browser smoke. This runs on the native macOS release runner,
// against the .app that will be archived, and proves the bridge reaches one
// main-owned manager with stable multi-tab state. Cross-built artifacts retain
// the structural checks above and must run their native smoke in their own CI.
if (apps.length > 0) {
  if (process.platform === 'darwin') {
    try {
      await runPackagedBrowserSmoke(selectRunnableApp(apps));
    } catch (error) {
      errors.push(`packaged browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push(`packaged browser runtime smoke skipped on ${process.platform}; run it on the artifact's native platform`);
  }
}

console.log('');
for (const w of warnings) console.log(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

console.log('✓ packaged-build structure and browser runtime verified.');
console.log('\nFinal acceptance (manual, on macOS hardware):');
console.log('  1. Install the .dmg and launch BrainRouter.');
console.log(
  '  2. Enable the computer-use tool (Settings → Computer use) and grant Accessibility + Screen Recording when prompted; relaunch.',
);
console.log(
  '  3. Ask the agent to take a screenshot, then to click a labelled target — confirm the approval prompt appears and the real cursor moves.',
);
console.log(
  '  4. Open two in-app browser tabs, switch between them, and confirm neither page reloads or loses form/scroll state.',
);
console.log(
  '  5. Ask the agent to list and inspect those tabs — confirm it reports the exact same visible tabs and no external browser process starts.',
);
console.log(
  '  6. A spct -a -t exec / notarytool staple check passes (Gatekeeper accepts the signed, notarized build).',
);
