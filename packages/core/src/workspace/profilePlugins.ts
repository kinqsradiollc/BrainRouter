/**
 * Package-owned workspace profile plugins.
 *
 * These artifacts use the same manifest and discovery contract as installed
 * plugins, but remain inert until a workspace runtime selects their pack id.
 * Keeping discovery here gives CLI and Desktop one availability/version view
 * without introducing a second plugin loader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPlugin, type DiscoveredPlugin } from '../plugin/discovery.js';

export type WorkspaceProfilePluginId = 'study' | 'research' | 'data' | 'writing' | 'frontend';

export interface WorkspaceProfilePluginDefinition {
  id: WorkspaceProfilePluginId;
  kind: 'profile' | 'capability';
  pluginName: string;
  skillIds: readonly string[];
}

export interface AvailableWorkspaceProfilePlugin extends WorkspaceProfilePluginDefinition {
  root: string;
  version: string;
  skillsRoot: string;
  plugin: DiscoveredPlugin;
}

export interface UnavailableWorkspaceProfilePlugin extends WorkspaceProfilePluginDefinition {
  reason: string;
}

export interface WorkspaceProfilePluginCatalog {
  available: AvailableWorkspaceProfilePlugin[];
  unavailable: UnavailableWorkspaceProfilePlugin[];
}

export interface WorkspaceProfilePluginCatalogOptions {
  /** Package-layout override for tests and embedders. */
  root?: string;
}

export const WORKSPACE_PROFILE_PLUGIN_DEFINITIONS: readonly WorkspaceProfilePluginDefinition[] = [
  {
    id: 'study',
    kind: 'profile',
    pluginName: 'profile-study',
    skillIds: ['learning-plan-skill', 'retrieval-practice-skill'],
  },
  {
    id: 'research',
    kind: 'profile',
    pluginName: 'profile-research',
    skillIds: ['evidence-research-skill', 'source-synthesis-skill'],
  },
  {
    id: 'data',
    kind: 'profile',
    pluginName: 'profile-data',
    skillIds: ['data-analysis-skill', 'experiment-validation-skill'],
  },
  {
    id: 'writing',
    kind: 'profile',
    pluginName: 'profile-writing',
    skillIds: ['structured-writing-skill', 'revision-skill'],
  },
  {
    id: 'frontend',
    kind: 'capability',
    pluginName: 'capability-frontend',
    skillIds: ['a11y-skill', 'browser-testing-skill', 'taste-skill'],
  },
] as const;

// dist/workspace/profilePlugins.js -> ../../profile-plugins = package assets.
const BUNDLED_PROFILE_PLUGINS_ROOT = fileURLToPath(new URL('../../profile-plugins', import.meta.url));

/** Inspect every package-owned profile plugin through the standard plugin parser. */
export function inspectWorkspaceProfilePlugins(
  options: WorkspaceProfilePluginCatalogOptions = {},
): WorkspaceProfilePluginCatalog {
  const root = path.resolve(options.root ?? BUNDLED_PROFILE_PLUGINS_ROOT);
  const available: AvailableWorkspaceProfilePlugin[] = [];
  const unavailable: UnavailableWorkspaceProfilePlugin[] = [];

  for (const definition of WORKSPACE_PROFILE_PLUGIN_DEFINITIONS) {
    const pluginRoot = path.join(root, definition.id);
    const discovered = discoverPlugin(pluginRoot);
    if (!discovered.ok) {
      unavailable.push({ ...definition, reason: discovered.error.errors.join('; ') });
      continue;
    }
    const plugin = discovered.plugin;
    if (plugin.name !== definition.pluginName) {
      unavailable.push({
        ...definition,
        reason: `manifest name must be ${definition.pluginName}`,
      });
      continue;
    }
    const version = plugin.manifest.version?.trim();
    if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      unavailable.push({ ...definition, reason: 'manifest version must be semantic' });
      continue;
    }
    const skillsRoot = plugin.contributes.skills;
    if (!skillsRoot || !isContainedDirectory(pluginRoot, skillsRoot)) {
      unavailable.push({ ...definition, reason: 'regular contained skills contribution is required' });
      continue;
    }
    const missingSkill = definition.skillIds.find((skillId) =>
      !isRegularSkillFile(path.join(skillsRoot, skillId, 'SKILL.md')));
    if (missingSkill) {
      unavailable.push({ ...definition, reason: `missing regular skill file: ${missingSkill}` });
      continue;
    }
    available.push({ ...definition, root: pluginRoot, version, skillsRoot, plugin });
  }

  return { available, unavailable };
}

/** Resolve one available profile plugin by manifest pack/capability id. */
export function findWorkspaceProfilePlugin(
  id: string,
  options: WorkspaceProfilePluginCatalogOptions = {},
): AvailableWorkspaceProfilePlugin | undefined {
  return inspectWorkspaceProfilePlugins(options).available.find((plugin) => plugin.id === id);
}

function isRegularSkillFile(filePath: string): boolean {
  try {
    return fs.lstatSync(path.dirname(filePath)).isDirectory() && fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isContainedDirectory(root: string, candidate: string): boolean {
  try {
    if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(candidate).isDirectory()) return false;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}
