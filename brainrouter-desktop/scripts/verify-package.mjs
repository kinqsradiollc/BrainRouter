#!/usr/bin/env node
/**
 * verify-package — static smoke check on an electron-builder output.
 *
 * Catches the #1 monorepo packaging risk: the workspace deps
 * (@kinqs/brainrouter-core, @kinqs/brainrouter-agent-protocol) or the agent
 * host being silently dropped from the asar. Run AFTER an electron-builder
 * build (the dist:* / dist:dir scripts):
 *
 *   npm run dist:dir && npm run verify:package
 *
 * Exits non-zero (with a clear reason) if anything required is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(pkgRoot, 'release');

// Everything the packaged app needs on the Node side (renderer deps are
// vite-bundled into dist/ and are not asserted here).
const REQUIRED = [
  'dist-electron/main.js',
  'dist-electron/host.js',
  'dist-electron/preload.cjs',
  'dist/index.html',
  'node_modules/@kinqs/brainrouter-core/dist/index.js',
  'node_modules/@kinqs/brainrouter-agent-protocol/dist/index.js',
];

function fail(msg) {
  console.error(`✗ verify-package: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  fail(`no release/ at ${releaseDir} — run an electron-builder build first (e.g. npm run dist:dir).`);
}

// Find packaged app payloads under release/: a bare app.asar, or an unpacked
// app/ dir (asar:false or *-unpacked layouts).
function findTargets(dir, depth = 0, hits = []) {
  if (depth > 5) return hits;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return hits; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === 'app.asar') hits.push({ type: 'asar', path: p });
    else if (e.isDirectory() && e.name === 'app' && fs.existsSync(path.join(p, 'package.json'))) hits.push({ type: 'dir', path: p });
    else if (e.isDirectory()) findTargets(p, depth + 1, hits);
  }
  return hits;
}

async function listAsar(asarPath) {
  // @electron/asar ships transitively with electron-builder.
  try {
    const asar = await import('@electron/asar');
    return new Set(asar.listPackage(asarPath).map((p) => p.replace(/^[\\/]+/, '').replace(/\\/g, '/')));
  } catch {
    return null;
  }
}

const targets = findTargets(releaseDir);
if (targets.length === 0) fail('no app.asar or unpacked app/ found under release/.');

let asserted = false;
for (const t of targets) {
  const where = path.relative(pkgRoot, t.path);
  if (t.type === 'dir') {
    for (const rel of REQUIRED) {
      if (!fs.existsSync(path.join(t.path, rel))) fail(`missing ${rel} in unpacked app (${where})`);
    }
    asserted = true;
    console.log(`✓ unpacked app OK (${where}) — host + core + agent-protocol present`);
  } else {
    const files = await listAsar(t.path);
    if (!files) {
      const sz = fs.statSync(t.path).size;
      if (sz < 1_000_000) fail(`app.asar suspiciously small (${sz} bytes): ${where}`);
      console.warn(`! @electron/asar not resolvable — only size-checked ${where} (${sz} bytes); content assertions skipped.`);
      continue;
    }
    for (const rel of REQUIRED) {
      if (!files.has(rel)) fail(`missing ${rel} inside ${where}`);
    }
    asserted = true;
    console.log(`✓ app.asar OK (${where}) — host + core + agent-protocol present`);
  }
}

if (!asserted) {
  fail('could not assert package contents (no unpacked dir, and asar tooling unavailable). Inconclusive — treat as failure.');
}
console.log('✓ verify-package: passed');
