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
import { readPersonaDefinitionFile } from './personaDefinitionFile.js';

export type WorkspaceProfilePluginId =
  | 'study'
  | 'research'
  | 'data'
  | 'writing'
  | 'frontend'
  | 'backend';

export interface WorkspaceProfilePluginDefinition {
  id: WorkspaceProfilePluginId;
  kind: 'profile' | 'capability';
  pluginName: string;
  skillIds: readonly string[];
  /** Optional domain identities contributed without execution authority. */
  personaIds: readonly string[];
}

export interface AvailableWorkspaceProfilePlugin extends WorkspaceProfilePluginDefinition {
  root: string;
  version: string;
  skillsRoot: string;
  personasRoot?: string;
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
    skillIds: [
      'learner-diagnostic-skill',
      'learning-plan-skill',
      'tutoring-explanation-skill',
      'learning-assessment-skill',
      'error-remediation-skill',
      'retrieval-practice-skill',
      'learning-source-skill',
    ],
    personaIds: ['tutor'],
  },
  {
    id: 'research',
    kind: 'profile',
    pluginName: 'profile-research',
    skillIds: [
      'research-question-skill',
      'source-strategy-skill',
      'iterative-evidence-skill',
      'evidence-research-skill',
      'claim-ledger-skill',
      'source-synthesis-skill',
      'citation-verification-skill',
      'research-review-skill',
      'academic-paper-drafting-skill',
      'academic-paper-review-skill',
    ],
    personaIds: ['researcher'],
  },
  {
    id: 'data',
    kind: 'profile',
    pluginName: 'profile-data',
    skillIds: ['data-analysis-skill', 'experiment-validation-skill'],
    personaIds: ['data-scientist'],
  },
  {
    id: 'writing',
    kind: 'profile',
    pluginName: 'profile-writing',
    skillIds: ['structured-writing-skill', 'revision-skill', 'writing-critique-skill'],
    personaIds: ['writer'],
  },
  {
    id: 'frontend',
    kind: 'capability',
    pluginName: 'capability-frontend',
    skillIds: ['a11y-skill', 'browser-testing-skill', 'taste-skill'],
    personaIds: [],
  },
  {
    id: 'backend',
    kind: 'capability',
    pluginName: 'capability-backend',
    skillIds: [
      'api-service-design-skill',
      'authorization-boundary-skill',
      'data-integrity-migration-skill',
      'background-work-skill',
      'production-readiness-skill',
      'backend-testing-skill',
    ],
    personaIds: [],
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
    const personasRoot = plugin.contributes.personas;
    if (definition.personaIds.length > 0) {
      if (!personasRoot || !isContainedDirectory(pluginRoot, personasRoot)) {
        unavailable.push({ ...definition, reason: 'regular contained personas contribution is required' });
        continue;
      }
      const missingPersona = definition.personaIds.find((personaId) =>
        !isValidPersonaFile(personasRoot, pluginRoot, personaId));
      if (missingPersona) {
        unavailable.push({ ...definition, reason: `missing valid persona file: ${missingPersona}` });
        continue;
      }
    }
    available.push({
      ...definition,
      root: pluginRoot,
      version,
      skillsRoot,
      ...(personasRoot ? { personasRoot } : {}),
      plugin,
    });
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

function isValidPersonaFile(personasRoot: string, pluginRoot: string, personaId: string): boolean {
  try {
    const definition = readPersonaDefinitionFile(
      path.join(personasRoot, `${personaId}.json`),
      personasRoot,
      pluginRoot,
    );
    return definition.id === personaId;
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
