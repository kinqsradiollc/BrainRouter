#!/usr/bin/env node
/**
 * CP-B — packaged-build verification.
 *
 * Runs against an electron-builder output to assert the bits that determine
 * whether native computer-use will work in the shipped app:
 *   1. a per-arch installer (.dmg / .zip) was produced;
 *   2. the libnut native module is UNPACKED from the asar (asarUnpack), so the
 *      `.node` binary is loadable at runtime (a packed .node can't be dlopen'd);
 *   3. (macOS, advisory) the .app is code-signed with a Developer ID and the
 *      hardened-runtime entitlements are embedded.
 *
 * The structural checks (1–2) FAIL the build; signing/notarization (3) is
 * advisory because the same pipeline runs without credentials (un-signed) to
 * verify itself. The final interactive step — granting Accessibility + Screen
 * Recording and watching the app drive a real click — is a human acceptance on
 * macOS hardware (TCC can't be granted non-interactively); it's printed below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const OUT_DIRS = ['dist', 'release', 'out'].map((d) => path.join(root, d));

function walk(dir, pred, hits = [], depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return hits;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (pred(p, e)) hits.push(p);
    if (e.isDirectory() && !e.name.endsWith('.app')) walk(p, pred, hits, depth + 1);
  }
  return hits;
}

const outDir = OUT_DIRS.find((d) => fs.existsSync(d));
if (!outDir) {
  console.error(`✗ no build output found (looked in: ${OUT_DIRS.map((d) => path.relative(root, d)).join(', ')}). Run \`npm run dist:mac\` first.`);
  process.exit(1);
}

const errors = [];
const warnings = [];

// 1) installers
const installers = walk(outDir, (p) => /\.(dmg|zip)$/i.test(p));
if (installers.length) console.log(`✓ ${installers.length} installer(s): ${installers.map((p) => path.basename(p)).join(', ')}`);
else errors.push('no .dmg/.zip installer produced');

// 2) the app bundle + unpacked native module
const apps = walk(outDir, (p, e) => e.isDirectory() && p.endsWith('.app'));
if (!apps.length) {
  errors.push('no .app bundle found in the output');
} else {
  for (const app of apps) {
    const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
    const nodeFiles = fs.existsSync(unpacked) ? walk(unpacked, (p) => p.endsWith('.node')) : [];
    const libnut = nodeFiles.some((p) => /libnut/i.test(p));
    if (libnut) console.log(`✓ ${path.basename(app)}: libnut native module unpacked (${nodeFiles.length} .node file(s))`);
    else errors.push(`${path.basename(app)}: libnut .node not found under app.asar.unpacked — computer-use would fail at runtime`);

    // 3) signing + entitlements (advisory)
    if (process.platform === 'darwin') {
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
        console.log(`✓ ${path.basename(app)}: code signature valid`);
        const ent = execFileSync('codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (/screen-recording|automation|disable-library-validation|com\.apple\.security/.test(ent)) console.log(`✓ ${path.basename(app)}: hardened-runtime entitlements embedded`);
        else warnings.push(`${path.basename(app)}: entitlements look minimal — confirm Accessibility + Screen Recording are present`);
      } catch {
        warnings.push(`${path.basename(app)}: not code-signed (expected for a credential-less pipeline run; a release build must set CSC_LINK + APPLE_* secrets)`);
      }
    }
  }
}

console.log('');
for (const w of warnings) console.log(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

console.log('✓ packaged-build structure verified.');
console.log('\nFinal acceptance (manual, on macOS hardware):');
console.log('  1. Install the .dmg and launch BrainRouter.');
console.log('  2. Enable the computer-use tool (Settings → Computer use) and grant Accessibility + Screen Recording when prompted; relaunch.');
console.log('  3. Ask the agent to take a screenshot, then to click a labelled target — confirm the approval prompt appears and the real cursor moves.');
console.log('  4. A spct -a -t exec / notarytool staple check passes (Gatekeeper accepts the signed, notarized build).');
