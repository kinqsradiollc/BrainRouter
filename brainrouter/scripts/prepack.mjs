#!/usr/bin/env node
// Copies the BrainRouter content directories (skills/, agents/, references/, docs/)
// from the monorepo root into this package right before `npm pack` / `npm publish`,
// so installed users get the canonical catalogue without needing the monorepo.
//
// Paired with scripts/postpack.mjs, which deletes the copies after pack completes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(packageDir, '..');

const DIRS = ['skills', 'agents', 'references', 'docs'];
const MARKER = path.join(packageDir, '.bundled-content.json');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

const copied = [];
for (const dir of DIRS) {
  const src = path.join(monorepoRoot, dir);
  const dest = path.join(packageDir, dir);
  if (!fs.existsSync(src)) {
    console.warn(`[prepack] skipping missing source: ${src}`);
    continue;
  }
  if (fs.existsSync(dest)) {
    // Already present (maybe a previous run left it). Skip rather than clobber.
    console.warn(`[prepack] ${dir}/ already exists in package; leaving as-is.`);
    continue;
  }
  copyDir(src, dest);
  copied.push(dir);
  console.log(`[prepack] copied ${dir}/`);
}

// Record what we copied so postpack only removes our own additions.
fs.writeFileSync(MARKER, JSON.stringify({ copied, at: new Date().toISOString() }, null, 2));
