#!/usr/bin/env node
// Removes the content directories copied by prepack.mjs, restoring the
// package working tree to its pre-pack state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const MARKER = path.join(packageDir, '.bundled-content.json');

if (!fs.existsSync(MARKER)) {
  console.warn('[postpack] no marker file found; nothing to clean up.');
  process.exit(0);
}

const { copied = [] } = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
for (const dir of copied) {
  const target = path.join(packageDir, dir);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[postpack] removed ${dir}/`);
  }
}
fs.rmSync(MARKER, { force: true });
