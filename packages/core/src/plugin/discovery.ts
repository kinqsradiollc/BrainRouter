/**
 * PLUGIN-MARKETPLACE P1 — disk-backed plugin DISCOVERY.
 *
 * Given a plugin root, read its manifest and resolve WHICH component paths it
 * actually contributes (auto-discovering the convention dirs when `contributes`
 * omits them). The result is inert DATA — the loader feeds
 * these paths into the existing subsystems (skills / agents / commands / hooks /
 * mcp / connectors / workflows). No parallel runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_CONVENTION_PATHS,
  parseManifest,
  type PluginManifest,
  type PluginComponentKind,
} from './manifest.js';

/** A plugin resolved from disk: manifest + absolute paths of what it contributes. */
export interface DiscoveredPlugin {
  /** Plugin name (from manifest). */
  name: string;
  /** Absolute plugin root (the folder holding `.brainrouter-plugin/`). */
  root: string;
  manifest: PluginManifest;
  /**
   * Absolute paths of each contributed component, present only when the path
   * exists on disk. `skills`/`agents`/`commands`/`workflows`/`connectors` are
   * DIRECTORIES; `hooks`/`mcpServers` are FILES.
   */
  contributes: Partial<Record<PluginComponentKind, string>>;
  warnings: string[];
}

export interface DiscoveryError {
  root: string;
  errors: string[];
}

export type DiscoveryResult =
  | { ok: true; plugin: DiscoveredPlugin }
  | { ok: false; error: DiscoveryError };

/** Absolute path of a plugin's manifest file. */
export function manifestPath(pluginRoot: string, altManifestNames: readonly string[] = []): string {
  return manifestCandidatePaths(pluginRoot, altManifestNames)[0];
}

export function manifestCandidatePaths(pluginRoot: string, altManifestNames: readonly string[] = []): string[] {
  return manifestFilenames(altManifestNames).map((name) => path.join(pluginRoot, PLUGIN_MANIFEST_DIR, name));
}

/** True when a directory looks like a plugin (has the manifest file). */
export function looksLikePlugin(pluginRoot: string, altManifestNames: readonly string[] = []): boolean {
  return !!findManifestFile(pluginRoot, altManifestNames);
}

const DIR_KINDS: ReadonlySet<PluginComponentKind> = new Set(['skills', 'agents', 'commands', 'workflows', 'connectors']);

/**
 * Read + validate a plugin at `pluginRoot`. Returns discovered component paths
 * (only those that exist), or a hard error when the manifest is missing/invalid.
 */
export function discoverPlugin(pluginRoot: string, opts: { altManifestNames?: readonly string[] } = {}): DiscoveryResult {
  const root = path.resolve(pluginRoot);
  const mPath = findManifestFile(root, opts.altManifestNames ?? []);
  let text: string;
  try {
    if (!mPath) throw new Error('missing manifest');
    text = fs.readFileSync(mPath, 'utf8');
  } catch {
    return { ok: false, error: { root, errors: [`missing manifest at ${PLUGIN_MANIFEST_DIR}/${manifestFilenames(opts.altManifestNames ?? []).join('|')}`] } };
  }

  const parsed = parseManifest(text);
  if (!parsed.valid || !parsed.manifest) {
    return { ok: false, error: { root, errors: parsed.errors } };
  }

  const manifest = parsed.manifest;
  const warnings = [...parsed.warnings];
  const contributes: Partial<Record<PluginComponentKind, string>> = {};

  for (const kind of Object.keys(PLUGIN_CONVENTION_PATHS) as PluginComponentKind[]) {
    const rel = manifest.contributes?.[kind] ?? PLUGIN_CONVENTION_PATHS[kind];
    const abs = path.resolve(root, rel);
    // Guard: a resolved component path must stay inside the plugin root.
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      warnings.push(`contributes.${kind} resolves outside the plugin root — skipped`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      // Explicitly declared but missing → warn; auto-discovered + absent → silent.
      if (manifest.contributes?.[kind]) warnings.push(`declared contributes.${kind} "${rel}" not found on disk`);
      continue;
    }
    const wantDir = DIR_KINDS.has(kind);
    if (wantDir && !stat.isDirectory()) {
      warnings.push(`contributes.${kind} "${rel}" must be a directory`);
      continue;
    }
    if (!wantDir && !stat.isFile()) {
      warnings.push(`contributes.${kind} "${rel}" must be a file`);
      continue;
    }
    contributes[kind] = abs;
  }

  return { ok: true, plugin: { name: manifest.name, root, manifest, contributes, warnings } };
}

function findManifestFile(pluginRoot: string, altManifestNames: readonly string[]): string | undefined {
  for (const candidate of manifestCandidatePaths(pluginRoot, altManifestNames)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported filename.
    }
  }
  return undefined;
}

function manifestFilenames(altManifestNames: readonly string[]): string[] {
  const out = [PLUGIN_MANIFEST_FILE];
  const seen = new Set(out);
  for (const raw of altManifestNames) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    if (name.includes('/') || name.includes('\\')) continue;
    if (!name.endsWith('.json')) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Count of each component a plugin contributes — the disclosure summary. */
export interface PluginProvides {
  skills: number;
  agents: number;
  commands: number;
  hooks: number;
  mcpServers: number;
  connectors: number;
  workflows: number;
}

function countSkillDirs(dir: string): number {
  // A skill is a subdir containing SKILL.md (mirrors skillCatalog discovery).
  let n = 0;
  const walk = (cur: string, depth: number): void => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full, depth - 1);
      else if (e.isFile() && e.name === 'SKILL.md') n++;
    }
  };
  walk(dir, 5);
  return n;
}

function countFilesByExt(dir: string, exts: readonly string[]): number {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  return entries.filter((e) => e.isFile() && exts.includes(path.extname(e.name).toLowerCase())).length;
}

function countHooks(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw.length;
    if (raw && typeof raw === 'object' && Array.isArray((raw as { hooks?: unknown[] }).hooks)) {
      return (raw as { hooks: unknown[] }).hooks.length;
    }
    return 1;
  } catch {
    return 0;
  }
}

function countMcpServers(file: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = (raw && typeof raw === 'object' && (raw as { mcpServers?: unknown }).mcpServers) || raw;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) return Object.keys(servers).length;
    return 0;
  } catch {
    return 0;
  }
}

/** Tally a discovered plugin's contributions for the consent/disclosure summary. */
export function summarizeProvides(plugin: DiscoveredPlugin): PluginProvides {
  const c = plugin.contributes;
  return {
    skills: c.skills ? countSkillDirs(c.skills) : 0,
    agents: c.agents ? countFilesByExt(c.agents, ['.md']) : 0,
    commands: c.commands ? countFilesByExt(c.commands, ['.md']) : 0,
    hooks: c.hooks ? countHooks(c.hooks) : 0,
    mcpServers: c.mcpServers ? countMcpServers(c.mcpServers) : 0,
    connectors: c.connectors ? countFilesByExt(c.connectors, ['.json']) : 0,
    workflows: c.workflows ? countFilesByExt(c.workflows, ['.js', '.mjs', '.json']) : 0,
  };
}
