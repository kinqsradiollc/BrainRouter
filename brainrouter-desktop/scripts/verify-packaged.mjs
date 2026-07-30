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
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const OUT_DIRS = ['dist', 'release', 'out'].map((d) => path.join(root, d));
const EXPECTED_ELECTRON_VERSION = '43.1.1';
const EXPECTED_CHROMIUM_MAJOR = 150;
// A credential-less macOS package can spend tens of seconds in the OS launch
// path before Electron creates its first renderer.
const PACKAGED_LAUNCH_TIMEOUT_MS = 90_000;

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

async function waitForPackagedSmokeResult(resultPath, child, logs, launchError) {
  const deadline = Date.now() + PACKAGED_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (launchError()) throw new Error(`could not launch the packaged app: ${launchError().message}${logs()}`);
    try {
      if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch {
      // The app writes through a temporary file and renames atomically. Retry
      // only for an unexpected filesystem race.
    }
    if (child.exitCode !== null) {
      throw new Error(`packaged app exited with code ${child.exitCode} before browser smoke completed${logs()}`);
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for the packaged browser smoke result${logs()}`);
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-packaged-browser-'));
  const workspace = path.join(tempRoot, 'workspace');
  const profile = path.join(tempRoot, 'profile');
  const resultPath = path.join(profile, 'result.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  const childEnv = {
    ...process.env,
    BRAINROUTER_DESKTOP_WORKSPACE: workspace,
    BRAINROUTER_PACKAGED_SMOKE_PROFILE: profile,
    BRAINROUTER_PACKAGED_SMOKE_RESULT: resultPath,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // Build-only Node flags inherited from CI are rejected by packaged Electron
  // and can prevent the application from reaching its first renderer.
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITE_DEV_SERVER_URL;
  let output = '';
  let launchError = null;
  const child = spawn(executable, [
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
    const result = await waitForPackagedSmokeResult(resultPath, child, logs, () => launchError);
    if (!result?.ok) {
      throw new Error(`packaged app browser self-test failed: ${result?.error || 'unknown error'}${logs()}`);
    }
    const smoke = result.smoke;
    if (!smoke?.bridge) throw new Error(`packaged app renderer did not expose the browser bridge${logs()}`);
    const chromiumMatch = /(?:Chrome|Chromium)\/(\d+)\./.exec(
      typeof smoke.userAgent === 'string' ? smoke.userAgent : '',
    );
    if (!chromiumMatch || Number(chromiumMatch[1]) !== EXPECTED_CHROMIUM_MAJOR) {
      throw new Error(`packaged runtime reported ${smoke.userAgent || 'no Chromium user agent'}; expected Chromium ${EXPECTED_CHROMIUM_MAJOR}`);
    }
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
