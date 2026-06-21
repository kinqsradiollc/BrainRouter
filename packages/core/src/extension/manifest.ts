/**
 * EXTENSION-MANIFEST (0.4.15) — discovery of extension folders across the same
 * three tiers as packs (built-in > user > workspace), resolving name collisions
 * by precedence. An extension folder holds `extension.json` + an entry module.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export type ExtensionSource = 'builtin' | 'user' | 'workspace';

export interface ExtensionManifest {
  name: string;
  version?: string;
  description?: string;
  /** Entry module relative to the extension folder. Default 'index.js'. */
  main?: string;
  /** Capabilities the extension declares it will register (shown in `ext list`). */
  contributes?: Array<'tools' | 'providers' | 'hooks' | 'panels'>;
}

export interface ExtensionInfo {
  name: string;
  description: string;
  version: string;
  source: ExtensionSource;
  dir: string;
  /** Absolute path to the entry module (may not exist if uncompiled). */
  entry: string;
  contributes: Array<'tools' | 'providers' | 'hooks' | 'panels'>;
}

const SOURCE_RANK: Record<ExtensionSource, number> = { builtin: 0, user: 1, workspace: 2 };

// Built-in extensions ship at the package root (like `packs/`):
// dist/extension/manifest.js → ../../extensions → brainrouter-cli/extensions.
const BUILTIN_EXTENSIONS_DIR = fileURLToPath(new URL('../../extensions', import.meta.url));

function home(): string {
  return process.env.BRAINROUTER_HOME ?? path.join(os.homedir(), '.config', 'brainrouter');
}

export function userExtensionsDir(): string {
  return path.join(home(), 'extensions');
}

export function workspaceExtensionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'extensions');
}

/** The (root, source) pairs to scan, in precedence order. */
export function extensionRoots(workspaceRoot?: string): Array<{ root: string; source: ExtensionSource }> {
  const roots: Array<{ root: string; source: ExtensionSource }> = [
    { root: BUILTIN_EXTENSIONS_DIR, source: 'builtin' },
    { root: userExtensionsDir(), source: 'user' },
  ];
  if (workspaceRoot) roots.push({ root: workspaceExtensionsDir(workspaceRoot), source: 'workspace' });
  return roots;
}

/** Parse `extension.json` in `dir` into an ExtensionInfo (or null if invalid). */
export function readExtensionManifest(dir: string, source: ExtensionSource): ExtensionInfo | null {
  const manifestPath = path.join(dir, 'extension.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : path.basename(dir);
    const main = typeof m.main === 'string' && m.main.trim() ? m.main.trim() : 'index.js';
    return {
      name,
      description: m.description ?? '',
      version: m.version ?? '0.0.0',
      source,
      dir,
      entry: path.join(dir, main),
      contributes: Array.isArray(m.contributes) ? m.contributes : [],
    };
  } catch {
    return null;
  }
}

/** Discover every extension folder (one level deep) under a root. */
export function discoverExtensionsIn(root: string, source: ExtensionSource): ExtensionInfo[] {
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExtensionInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const info = readExtensionManifest(path.join(root, e.name), source);
    if (info) out.push(info);
  }
  return out;
}

/** Discover across all tiers (unresolved — may contain name dupes). */
export function discoverExtensions(workspaceRoot?: string): ExtensionInfo[] {
  return extensionRoots(workspaceRoot).flatMap(({ root, source }) => discoverExtensionsIn(root, source));
}

/** Resolve name collisions by precedence (workspace > user > built-in). Pure. */
export function resolveExtensions(found: ExtensionInfo[]): ExtensionInfo[] {
  const byName = new Map<string, ExtensionInfo>();
  for (const ext of found) {
    const existing = byName.get(ext.name);
    if (!existing || SOURCE_RANK[ext.source] >= SOURCE_RANK[existing.source]) byName.set(ext.name, ext);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The resolved set of extensions available in this workspace. */
export function listExtensions(workspaceRoot?: string): ExtensionInfo[] {
  return resolveExtensions(discoverExtensions(workspaceRoot));
}
