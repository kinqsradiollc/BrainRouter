/**
 * PLUGIN-MARKETPLACE P1 — plugin INSTALL with atomic staging (plan §3.5, Kimi).
 *
 * fetch (copy local / `git clone`) → `~/.brainrouter/plugins/.staging/<tmp>` →
 * validate the manifest → `rename` into place → write `install.json`. A failed
 * install NEVER touches a live copy: everything happens in staging first and a
 * pre-existing plugin dir is only replaced after the staged copy validates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  pluginInstallRoot,
  stagingDir,
  INSTALL_RECORD_FILE,
  type PluginInstallRecord,
  type PluginScope,
} from './paths.js';
import { discoverPlugin } from './discovery.js';
import { hashDirectory, compareDigest } from './integrity.js';
import type { PluginManifest } from './manifest.js';

export interface InstallOptions {
  scope?: PluginScope;
  workspaceRoot?: string;
  /** git ref (branch/tag/commit) for a git source. */
  ref?: string;
  /** Overwrite an existing install of the same name. Default false → refuse. */
  force?: boolean;
  /**
   * PLUGIN-MARKETPLACE P2 — a sub-path INSIDE the fetched source that holds the
   * actual plugin (monorepo marketplaces where one repo bundles many plugins;
   * plan §3.3 `sparsePaths`). After fetch, the staged root is narrowed to this
   * sub-directory before validation. Must stay inside the fetched tree.
   */
  subPath?: string;
  /** PLUGIN-MARKETPLACE P2 — marketplace name recorded in `install.json` when
   *  this install came from `plugin install <name>` (install-by-name). */
  marketplace?: string;
  /**
   * PLUGIN-MARKETPLACE P3 — expected sha256 `integrity` (from the registry
   * entry). When set, the staged plugin's deterministic tree digest is verified
   * BEFORE it is moved into place; a mismatch ABORTS (the live copy is untouched
   * — the atomic-staging guarantee). Blank/undefined ⇒ no integrity pin (a git
   * source carries its own ref/revision guarantee).
   */
  integrity?: string;
}

export type InstallResult =
  | { ok: true; name: string; installedTo: string; manifest: PluginManifest; record: PluginInstallRecord; warnings: string[] }
  | { ok: false; error: string };

/** Classify a source string as a local path or a git url. */
export function classifySource(source: string): 'local' | 'git' {
  const s = source.trim();
  if (/^git\+/.test(s) || /^(https?|git|ssh):\/\//.test(s) || /^git@/.test(s) || /\.git(#.*)?$/.test(s)) {
    return 'git';
  }
  return 'local';
}

/** Strip a leading `git+` scheme + trailing `#ref` fragment from a git url. */
function parseGitUrl(source: string): { url: string; ref?: string } {
  let s = source.trim().replace(/^git\+/, '');
  let ref: string | undefined;
  const hash = s.lastIndexOf('#');
  if (hash >= 0) {
    ref = s.slice(hash + 1) || undefined;
    s = s.slice(0, hash);
  }
  return { url: s, ref };
}

function rmrf(target: string): void {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Recursively copy a directory (skipping .git and node_modules). */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isSymbolicLink()) { /* skip symlinks — never follow out of tree */ }
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Install a plugin from a LOCAL path or a GIT url. Atomic: the live copy is only
 * touched after the staged copy validates.
 */
export function installPlugin(source: string, opts: InstallOptions = {}): InstallResult {
  const scope: PluginScope = opts.scope ?? 'user';
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const sourceType = classifySource(source);

  const staging = stagingDir();
  fs.mkdirSync(staging, { recursive: true });
  const stageRoot = path.join(staging, `install-${randomUUID()}`);

  let revision: string | undefined;
  let ref = opts.ref;

  try {
    if (sourceType === 'local') {
      const abs = path.resolve(source);
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { return { ok: false, error: `local source not found: ${abs}` }; }
      if (!stat.isDirectory()) return { ok: false, error: `local source is not a directory: ${abs}` };
      copyDir(abs, stageRoot);
    } else {
      const { url, ref: urlRef } = parseGitUrl(source);
      ref = ref ?? urlRef;
      fs.mkdirSync(stageRoot, { recursive: true });
      const cloneArgs = ['clone', '--depth', '1'];
      if (ref) cloneArgs.push('--branch', ref);
      cloneArgs.push(url, stageRoot);
      const clone = spawnSync('git', cloneArgs, { encoding: 'utf8' });
      if (clone.status !== 0) {
        // Retry without --branch (ref may be a commit sha, not a branch/tag).
        rmrf(stageRoot);
        const plain = spawnSync('git', ['clone', url, stageRoot], { encoding: 'utf8' });
        if (plain.status !== 0) {
          return { ok: false, error: `git clone failed: ${(clone.stderr || plain.stderr || '').trim()}` };
        }
        if (ref) {
          const co = spawnSync('git', ['-C', stageRoot, 'checkout', ref], { encoding: 'utf8' });
          if (co.status !== 0) return { ok: false, error: `git checkout ${ref} failed: ${(co.stderr || '').trim()}` };
        }
      }
      const rev = spawnSync('git', ['-C', stageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (rev.status === 0) revision = rev.stdout.trim();
    }

    // P2 — narrow to a sub-path INSIDE the fetched source (monorepo bundling).
    // Guard: the resolved sub-path must stay inside the staged tree.
    let effectiveRoot = stageRoot;
    if (opts.subPath && opts.subPath.trim()) {
      const rel = opts.subPath.trim().replace(/^[/\\]+/, '');
      const candidate = path.resolve(stageRoot, rel);
      const relToRoot = path.relative(stageRoot, candidate);
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        return { ok: false, error: `subPath "${opts.subPath}" resolves outside the fetched source` };
      }
      let stat: fs.Stats;
      try { stat = fs.statSync(candidate); } catch { return { ok: false, error: `subPath "${opts.subPath}" not found in source` }; }
      if (!stat.isDirectory()) return { ok: false, error: `subPath "${opts.subPath}" is not a directory` };
      effectiveRoot = candidate;
    }

    // Validate the staged copy BEFORE touching any live dir.
    const disc = discoverPlugin(effectiveRoot);
    if (!disc.ok) {
      return { ok: false, error: `invalid plugin: ${disc.error.errors.join('; ')}` };
    }
    const { name } = disc.plugin;

    // P3 — integrity gate: verify the staged tree against the declared sha256
    // BEFORE touching any live dir. A mismatch aborts the install (atomic).
    if (opts.integrity && opts.integrity.trim()) {
      const digest = hashDirectory(effectiveRoot);
      const check = compareDigest(digest, opts.integrity);
      if (!check.ok) {
        return { ok: false, error: `integrity check failed for "${name}": ${check.message ?? 'mismatch'}` };
      }
    }

    const target = pluginInstallRoot(scope, name, workspaceRoot);

    if (fs.existsSync(target)) {
      if (!opts.force) {
        return { ok: false, error: `plugin "${name}" already installed at ${target} (use --force to replace)` };
      }
    }

    // Drop the install record into the STAGED copy (the sub-path root when
    // narrowed), then swap that dir atomically into place.
    const record: PluginInstallRecord = {
      source: source.trim(),
      sourceType,
      ref,
      revision,
      installedAt: new Date().toISOString(),
      scope,
    };
    if (opts.subPath && opts.subPath.trim()) record.subPath = opts.subPath.trim();
    if (opts.marketplace && opts.marketplace.trim()) record.marketplace = opts.marketplace.trim();
    fs.writeFileSync(path.join(effectiveRoot, INSTALL_RECORD_FILE), JSON.stringify(record, null, 2));

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Replace atomically where possible: move the OLD dir aside, rename NEW in,
    // then delete OLD. If the rename fails the old copy is restored (untouched).
    const backup = fs.existsSync(target) ? `${target}.old-${randomUUID()}` : null;
    if (backup) fs.renameSync(target, backup);
    try {
      fs.renameSync(effectiveRoot, target);
    } catch (err) {
      // Cross-device rename can fail; fall back to copy.
      try {
        copyDir(effectiveRoot, target);
        rmrf(stageRoot);
      } catch (copyErr) {
        if (backup) fs.renameSync(backup, target); // restore prior live copy
        return { ok: false, error: `failed to move plugin into place: ${(err as Error).message}; ${(copyErr as Error).message}` };
      }
    }
    if (backup) rmrf(backup);

    return { ok: true, name, installedTo: target, manifest: disc.plugin.manifest, record, warnings: disc.plugin.warnings };
  } finally {
    rmrf(stageRoot);
  }
}

export interface RemoveResult {
  ok: boolean;
  removed?: string;
  error?: string;
}

/** Remove an installed plugin by name from a scope. */
export function removePlugin(name: string, opts: { scope?: PluginScope; workspaceRoot?: string } = {}): RemoveResult {
  const scope = opts.scope ?? 'user';
  const target = pluginInstallRoot(scope, name, opts.workspaceRoot ?? process.cwd());
  if (!fs.existsSync(target)) return { ok: false, error: `plugin "${name}" not installed in ${scope} scope` };
  rmrf(target);
  return { ok: true, removed: target };
}

/** Read the `install.json` for an installed plugin, if present. */
export function readInstallRecord(pluginRoot: string): PluginInstallRecord | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginRoot, INSTALL_RECORD_FILE), 'utf8'));
    return raw as PluginInstallRecord;
  } catch {
    return undefined;
  }
}
