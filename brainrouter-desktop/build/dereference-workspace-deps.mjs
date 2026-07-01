// Signed-build helper (CI): electron-builder refuses node_modules entries that
// are symlinks escaping the app directory — exactly what npm workspaces create
// for @kinqs/* (root node_modules/@kinqs/X → ../../packages/X). Replace each
// workspace symlink with a REAL copy (package.json + dist + license) so the
// module collector sees ordinary packages. Run AFTER build:deps (dist must
// exist) and BEFORE electron-builder. `npm install` restores the symlinks, so
// local trees self-heal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scopeDir = path.join(repoRoot, 'node_modules', '@kinqs');

if (!fs.existsSync(scopeDir)) {
  console.log('[dereference-workspace-deps] no @kinqs scope dir — nothing to do');
  process.exit(0);
}

for (const entry of fs.readdirSync(scopeDir)) {
  const linkPath = path.join(scopeDir, entry);
  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    console.log(`[dereference-workspace-deps] ${entry}: already a real directory`);
    continue;
  }
  const target = fs.realpathSync(linkPath);
  const pkgJson = path.join(target, 'package.json');
  const dist = path.join(target, 'dist');
  if (!fs.existsSync(pkgJson) || !fs.existsSync(dist)) {
    console.error(`[dereference-workspace-deps] ${entry}: missing package.json or dist/ at ${target} — run the workspace builds first`);
    process.exit(1);
  }
  fs.rmSync(linkPath);
  fs.mkdirSync(linkPath, { recursive: true });
  fs.copyFileSync(pkgJson, path.join(linkPath, 'package.json'));
  fs.cpSync(dist, path.join(linkPath, 'dist'), { recursive: true, dereference: true });
  for (const extra of ['LICENSE', 'README.md']) {
    const src = path.join(target, extra);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(linkPath, extra));
  }
  console.log(`[dereference-workspace-deps] ${entry}: symlink → real copy (${target})`);
}
