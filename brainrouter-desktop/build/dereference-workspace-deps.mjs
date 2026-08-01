// Signed-build helper (CI): electron-builder refuses node_modules entries that
// are symlinks escaping the app directory — exactly what npm workspaces create
// for @kinqs/* (root node_modules/@kinqs/X → ../../packages/X). Replace each
// workspace symlink with a REAL copy of the package's declared `files` contract
// so the module collector sees ordinary packages with every runtime asset.
// Run AFTER build:deps (dist must exist) and BEFORE electron-builder.
// `npm install` restores the symlinks, so local trees self-heal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyDeclaredPackageFiles } from './workspace-package-files.mjs';

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
    // Not part of the desktop's dependency closure (e.g. the CLI workspace) —
    // electron-builder never visits it, so an unbuilt package is fine to skip.
    console.log(`[dereference-workspace-deps] ${entry}: no dist build — skipping (not a packaged dep)`);
    continue;
  }
  const packageJson = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  fs.rmSync(linkPath);
  fs.mkdirSync(linkPath, { recursive: true });
  fs.copyFileSync(pkgJson, path.join(linkPath, 'package.json'));
  const copied = copyDeclaredPackageFiles(target, linkPath, packageJson);
  for (const extra of ['LICENSE', 'README.md']) {
    const src = path.join(target, extra);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(linkPath, extra));
  }
  console.log(
    `[dereference-workspace-deps] ${entry}: symlink → real copy (${target}; files: ${copied.join(', ')})`,
  );
}
