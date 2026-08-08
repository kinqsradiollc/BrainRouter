#!/usr/bin/env node
// Copies the BrainRouter content directories (skills/, agents/, references/, docs/)
// from the monorepo root into this package right before `npm pack` / `npm publish`,
// so installed users get the canonical catalogue without needing the monorepo.
//
// The copy itself lives in scripts/bundle-content.mjs at the monorepo root, which
// packages/core and brainrouter-cli now use too (ADR-031 D2) — three packages
// copying the same library with three copiers is how the copies would start to
// differ. The third-party notice is generated here from what actually landed in
// the package, so licensed content can never ship without it (ADR-031 D3).
//
// Paired with scripts/postpack.mjs, which deletes the copies after pack completes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyContentDir,
  THIRD_PARTY_NOTICE_FILE,
  writeThirdPartyNotice,
} from '../../scripts/bundle-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const monorepoRoot = path.resolve(packageDir, '..');

const DIRS = ['skills', 'agents', 'references', 'docs'];
const MARKER = path.join(packageDir, '.bundled-content.json');

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
  copyContentDir(src, dest);
  copied.push(dir);
  console.log(`[prepack] copied ${dir}/`);
}

// Generated from every content directory present, not only the ones this run
// copied: the notice must describe the package as it will be packed.
writeThirdPartyNotice(packageDir, DIRS);
console.log(`[prepack] generated ${THIRD_PARTY_NOTICE_FILE}`);

// Record what we generated so postpack only removes our own additions.
fs.writeFileSync(
  MARKER,
  JSON.stringify({ copied, generated: [THIRD_PARTY_NOTICE_FILE], at: new Date().toISOString() }, null, 2),
);
