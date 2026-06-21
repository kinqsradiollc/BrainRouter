/**
 * MAS-P5-T4 (0.4.2) — agent-definition packs.
 *
 * A pack bundles related agents (and, later, commands / skills / hooks /
 * mcp) into one installable folder so a workflow like "feature-dev" or
 * "pr-review" ships as a unit. Packs live at three tiers and resolve
 * workspace > user > built-in (a workspace pack shadows a same-named user
 * or built-in one):
 *
 *   built-in   <cli>/packs/<name>/
 *   user       ~/.config/brainrouter/packs/<name>/
 *   workspace  <workspace>/.brainrouter/packs/<name>/
 *
 * Each pack folder contains a `pack.json` manifest plus optional
 * `agents/`, `commands/`, `skills/`, `hooks/`, and `mcp.json`. This module
 * is the pure discovery + resolution layer; enable/disable state lives in
 * `state/packStore.ts`, and `agentRegistry` consumes enabled packs' agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export type PackSource = 'builtin' | 'user' | 'workspace';

export interface PackManifest {
  name: string;
  description?: string;
  version?: string;
  /** Subdir holding agent JSON defs. Default 'agents'. */
  agentsDir?: string;
}

export interface PackInfo {
  name: string;
  description: string;
  version: string;
  source: PackSource;
  dir: string;
  /** Absolute path to the pack's agents dir (may not exist). */
  agentsDir: string;
}

/** Source precedence — higher wins when names collide. */
const SOURCE_RANK: Record<PackSource, number> = { builtin: 0, user: 1, workspace: 2 };

// Built-in packs ship at the package root (like `agents/`): from
// dist/orchestration/packs.js → ../../packs → brainrouter-cli/packs.
const BUILTIN_PACKS_DIR = fileURLToPath(new URL('../../packs', import.meta.url));

export function userPacksDir(): string {
  const home = process.env.BRAINROUTER_HOME ?? path.join(os.homedir(), '.config', 'brainrouter');
  return path.join(home, 'packs');
}

export function workspacePacksDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'packs');
}

/** The three (root, source) pairs to scan, in precedence order. */
export function packRoots(workspaceRoot?: string): Array<{ root: string; source: PackSource }> {
  const roots: Array<{ root: string; source: PackSource }> = [
    { root: BUILTIN_PACKS_DIR, source: 'builtin' },
    { root: userPacksDir(), source: 'user' },
  ];
  if (workspaceRoot) roots.push({ root: workspacePacksDir(workspaceRoot), source: 'workspace' });
  return roots;
}

/** Parse a pack.json into a normalized PackInfo (or null if invalid). */
export function readPackManifest(dir: string, source: PackSource): PackInfo | null {
  const manifestPath = path.join(dir, 'pack.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PackManifest;
    const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : path.basename(dir);
    return {
      name,
      description: manifest.description ?? '',
      version: manifest.version ?? '0.0.0',
      source,
      dir,
      agentsDir: path.join(dir, manifest.agentsDir ?? 'agents'),
    };
  } catch {
    return null;
  }
}

/** Discover every pack folder (one level deep) under a root. */
export function discoverPacksIn(root: string, source: PackSource): PackInfo[] {
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs: PackInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const info = readPackManifest(path.join(root, entry.name), source);
    if (info) packs.push(info);
  }
  return packs;
}

/** Discover packs across all tiers (unresolved — may contain name dupes). */
export function discoverPacks(workspaceRoot?: string): PackInfo[] {
  return packRoots(workspaceRoot).flatMap(({ root, source }) => discoverPacksIn(root, source));
}

/**
 * Resolve name collisions by precedence (workspace > user > built-in).
 * Pure — takes the raw discovered list, returns one PackInfo per name.
 */
export function resolvePacks(packs: PackInfo[]): PackInfo[] {
  const byName = new Map<string, PackInfo>();
  for (const p of packs) {
    const existing = byName.get(p.name);
    if (!existing || SOURCE_RANK[p.source] >= SOURCE_RANK[existing.source]) {
      byName.set(p.name, p);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** The resolved set of packs available in this workspace. */
export function listPacks(workspaceRoot?: string): PackInfo[] {
  return resolvePacks(discoverPacks(workspaceRoot));
}

/** Agent ids a pack contributes (reads its agents dir). */
export function packAgentIds(pack: PackInfo): string[] {
  if (!fs.existsSync(pack.agentsDir)) return [];
  try {
    return fs
      .readdirSync(pack.agentsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const id = (JSON.parse(fs.readFileSync(path.join(pack.agentsDir, f), 'utf-8')) as { id?: string }).id;
          return id || f.replace(/\.json$/, '');
        } catch {
          return f.replace(/\.json$/, '');
        }
      });
  } catch {
    return [];
  }
}
