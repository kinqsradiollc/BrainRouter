/**
 * PLUGIN-MARKETPLACE P1 — the plugin LOADER (the reuse layer).
 *
 * Given a workspace root + config, resolve the ENABLED plugins across both
 * scopes (user `~/.brainrouter/plugins/<name>/` and workspace
 * `<ws>/.brainrouter/plugins/<name>/`) and produce the aggregate contributions
 * the CLI/host feed into the EXISTING subsystems — skills, agents, commands,
 * hooks, mcp, connectors, workflows. No parallel runtime: a plugin is inert
 * data that populates systems we already ship.
 *
 * Collisions across plugins are disambiguated `<pluginName>:<name>` (mirroring
 * the skill-collision display we shipped). Loading is SKIPPED entirely under
 * `cli.safeMode`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config, ResolvedCliKnobs } from '../config/configTypes.js';
import { resolveCliKnobs } from '../config/config.js';
import {
  pluginsDirForScope,
  type PluginScope,
} from './paths.js';
import { getOrgConventionRepoRoots } from './orgConvention.js';
import {
  discoverPlugin,
  looksLikePlugin,
  summarizeProvides,
  type DiscoveredPlugin,
  type PluginProvides,
} from './discovery.js';
import { expandPluginRoot } from './manifest.js';
import { commandHooksEnabled, hooksAllowed, mcpServersEnabled } from './trust.js';

/** A plugin that was resolved AND enabled, tagged with its scope + disclosure. */
export type PluginLoadScope = PluginScope | 'org';

export interface LoadedPlugin extends DiscoveredPlugin {
  scope: PluginLoadScope;
  enabled: boolean;
  provides: PluginProvides;
  /** PLUGIN-MARKETPLACE P3 — whether this plugin's risky capabilities loaded. */
  hooksGated?: boolean;
  mcpGated?: boolean;
}

/**
 * Aggregate contributions across all loaded plugins, ready to feed subsystems.
 * `skillRoots` append to the CLI's `skillSearchRoots`; the file/dir lists carry
 * `{ pluginName, path }` so a caller can namespace on collision.
 */
export interface PluginContributions {
  /** Plugin skill DIRECTORIES — appended to skillSearchRoots. */
  skillRoots: string[];
  agentFiles: Array<{ pluginName: string; path: string }>;
  commandFiles: Array<{ pluginName: string; path: string }>;
  hookFiles: Array<{ pluginName: string; path: string }>;
  connectorFiles: Array<{ pluginName: string; path: string }>;
  workflowFiles: Array<{ pluginName: string; path: string }>;
  /** MCP server config files ({ pluginName, path, pluginRoot } for ${BRAINROUTER_PLUGIN_ROOT}). */
  mcpConfigFiles: Array<{ pluginName: string; path: string; pluginRoot: string }>;
}

export interface LoadPluginsResult {
  /** Enabled + resolved plugins (empty under safeMode or when none enabled). */
  loaded: LoadedPlugin[];
  /** Aggregate contributions to feed the subsystems. */
  contributions: PluginContributions;
  /** Plugins present on disk but NOT enabled (surfaced by `plugin list`). */
  disabled: DiscoveredPlugin[];
  /** Per-plugin discovery warnings + hard errors (invalid manifests etc.). */
  warnings: string[];
  errors: string[];
  /** True when loading was skipped because safeMode is on. */
  skippedForSafeMode: boolean;
}

function emptyContributions(): PluginContributions {
  return {
    skillRoots: [],
    agentFiles: [],
    commandFiles: [],
    hookFiles: [],
    connectorFiles: [],
    workflowFiles: [],
    mcpConfigFiles: [],
  };
}

/** List immediate subdirectories of a plugins dir that look like plugins. */
function pluginDirsIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    // Skip the staging dir + dotfiles.
    if (e.name.startsWith('.')) continue;
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (looksLikePlugin(full)) out.push(full);
  }
  return out;
}

/**
 * Resolve + load enabled plugins. Precedence when the SAME plugin name exists in
 * both scopes: WORKSPACE overrides USER (a project pins its own copy). The enable
 * map (`cli.plugins.enabled`) is keyed by plugin name; a plugin defaults DISABLED.
 */
export function loadPlugins(workspaceRoot: string, config?: Config): LoadPluginsResult {
  return loadPluginsWithKnobs(workspaceRoot, resolveCliKnobs(config));
}

/**
 * Loader variant taking ALREADY-RESOLVED knobs — for callers that hold the
 * resolved knobs but must NOT trigger a config-file read (e.g. the CLI skill
 * catalog, where `loadConfig()` would `process.exit(1)` with no config on disk).
 */
export function loadPluginsWithKnobs(
  workspaceRoot: string,
  knobs: Pick<ResolvedCliKnobs, 'safeMode' | 'plugins' | 'skills'>,
): LoadPluginsResult {
  if (knobs.safeMode) {
    return {
      loaded: [],
      contributions: emptyContributions(),
      disabled: [],
      warnings: [],
      errors: [],
      skippedForSafeMode: true,
    };
  }

  const enabledMap = knobs.plugins.enabled;
  const warnings: string[] = [];
  const errors: string[] = [];
  const contributions = emptyContributions();

  // Scan user first, then org convention roots, then workspace so local project
  // choices win on same-name while org repositories stay read-only.
  const scopes: PluginScope[] = ['user', 'workspace'];
  const byName = new Map<string, DiscoveredPlugin & { scope: PluginLoadScope }>();

  for (const scope of scopes) {
    if (scope === 'workspace' && knobs.skills?.orgRepoDiscovery === true) {
      for (const repoRoot of getOrgConventionRepoRoots()) {
        addOrgConventionRepo(repoRoot, byName, contributions);
      }
    }
    const dir = pluginsDirForScope(scope, workspaceRoot);
    for (const pluginRoot of pluginDirsIn(dir)) {
      const res = discoverPlugin(pluginRoot);
      if (!res.ok) {
        errors.push(`${pluginRoot}: ${res.error.errors.join('; ')}`);
        continue;
      }
      for (const w of res.plugin.warnings) warnings.push(`${res.plugin.name}: ${w}`);
      byName.set(res.plugin.name, { ...res.plugin, scope });
    }
  }

  const loaded: LoadedPlugin[] = [];
  const disabled: DiscoveredPlugin[] = [];

  for (const plugin of byName.values()) {
    const isEnabled = enabledMap[plugin.name] === true;
    if (!isEnabled) {
      disabled.push(plugin);
      continue;
    }
    const provides = summarizeProvides(plugin);
    const approved = knobs.plugins.approved[plugin.name];

    const c = plugin.contributes;
    if (c.skills) contributions.skillRoots.push(c.skills);
    if (c.agents) contributions.agentFiles.push(...listEntries(c.agents, plugin.name, ['.md']));
    if (c.commands) contributions.commandFiles.push(...listEntries(c.commands, plugin.name, ['.md']));
    if (c.connectors) contributions.connectorFiles.push(...listEntries(c.connectors, plugin.name, ['.json']));
    if (c.workflows) contributions.workflowFiles.push(...listEntries(c.workflows, plugin.name, ['.js', '.mjs', '.json']));

    // PLUGIN-MARKETPLACE P3 — gate the risky (shell/MCP) capabilities. Hooks with
    // a command-type entry need per-plugin SHELL consent; a `allowManagedHooksOnly`
    // managed gate refuses third-party plugin hooks outright. MCP command-servers
    // need per-plugin MCP consent. Skills/agents/commands/connectors/workflows are
    // whitelist-safe and always load on `enabled` alone.
    let hooksGated = false;
    let mcpGated = false;
    if (c.hooks) {
      const hasCommandHook = fileHasCommandHook(c.hooks);
      const allowed = hasCommandHook
        ? commandHooksEnabled(knobs.plugins, approved)
        : hooksAllowed(knobs.plugins);
      if (allowed) contributions.hookFiles.push({ pluginName: plugin.name, path: c.hooks });
      else {
        hooksGated = true;
        if (knobs.plugins.allowManagedHooksOnly) {
          warnings.push(`${plugin.name}: hooks refused — allowManagedHooksOnly is on (managed policy)`);
        } else {
          warnings.push(`${plugin.name}: command hooks disabled — approve with \`brainrouter plugin trust ${plugin.name} --shell\``);
        }
      }
    }
    if (c.mcpServers) {
      if (mcpServersEnabled(approved)) {
        contributions.mcpConfigFiles.push({ pluginName: plugin.name, path: c.mcpServers, pluginRoot: plugin.root });
      } else {
        mcpGated = true;
        warnings.push(`${plugin.name}: MCP servers disabled — approve with \`brainrouter plugin trust ${plugin.name} --mcp\``);
      }
    }

    loaded.push({ ...plugin, enabled: true, provides, hooksGated, mcpGated });
  }

  return { loaded, contributions, disabled, warnings, errors, skippedForSafeMode: false };
}

function addOrgConventionRepo(
  repoRoot: string,
  byName: Map<string, DiscoveredPlugin & { scope: PluginLoadScope }>,
  contributions: PluginContributions,
): void {
  const skillsDir = path.join(repoRoot, 'skills');
  if (dirExists(skillsDir)) contributions.skillRoots.push(skillsDir);

  const agentsDir = path.join(repoRoot, 'agents');
  if (dirExists(agentsDir)) {
    contributions.agentFiles.push(...listEntries(agentsDir, `org:${path.basename(path.dirname(repoRoot))}`, ['.md']));
  }

  for (const pluginRoot of pluginDirsIn(path.join(repoRoot, 'plugins'))) {
    const res = discoverPlugin(pluginRoot);
    if (res.ok) byName.set(res.plugin.name, { ...res.plugin, scope: 'org' });
  }
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** True when a hooks.json declares at least one command-type hook (shell-risky).
 *  A parse failure / prompt-only file returns false (no shell gate needed). */
function fileHasCommandHook(hooksFile: string): boolean {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(hooksFile, 'utf8')); } catch { return false; }
  const found = { hit: false };
  const visit = (h: unknown): void => {
    if (found.hit || !h || typeof h !== 'object') return;
    if (Array.isArray(h)) { for (const x of h) visit(x); return; }
    const obj = h as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    if (typeof obj.command === 'string' && (type === undefined || type === 'command')) { found.hit = true; return; }
    for (const v of Object.values(obj)) if (Array.isArray(v) || (v && typeof v === 'object')) visit(v);
  };
  visit(raw);
  return found.hit;
}

function listEntries(dir: string, pluginName: string, exts: readonly string[]): Array<{ pluginName: string; path: string }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: Array<{ pluginName: string; path: string }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!exts.includes(path.extname(e.name).toLowerCase())) continue;
    out.push({ pluginName, path: path.join(dir, e.name) });
  }
  return out;
}

/**
 * Load an MCP-servers config file and expand `${BRAINROUTER_PLUGIN_ROOT}` in
 * `command`/`args` so a plugin's server can reference its own bundled script
 * portably. Returns a `{ serverId → serverConfig }` map with
 * IDs namespaced `<pluginName>:<serverId>` to avoid collisions. Never throws.
 */
export function readPluginMcpServers(
  entry: { pluginName: string; path: string; pluginRoot: string },
): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
  } catch {
    return {};
  }
  const servers = (raw && typeof raw === 'object' && (raw as { mcpServers?: unknown }).mcpServers) || raw;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  const out: Record<string, unknown> = {};
  for (const [id, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const expanded = expandServerPaths(cfg as Record<string, unknown>, entry.pluginRoot);
    out[`${entry.pluginName}:${id}`] = expanded;
  }
  return out;
}

function expandServerPaths(cfg: Record<string, unknown>, pluginRoot: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg };
  if (typeof out.command === 'string') out.command = expandPluginRoot(out.command, pluginRoot);
  if (Array.isArray(out.args)) {
    out.args = out.args.map((a) => (typeof a === 'string' ? expandPluginRoot(a, pluginRoot) : a));
  }
  if (out.env && typeof out.env === 'object' && !Array.isArray(out.env)) {
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.env as Record<string, unknown>)) {
      env[k] = typeof v === 'string' ? expandPluginRoot(v, pluginRoot) : v;
    }
    out.env = env;
  }
  return out;
}
