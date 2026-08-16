/**
 * Manifest-scoped skill bundle selection.
 *
 * This resolver turns reviewed workspace choices plus task-time capability
 * state into inert catalog data for CLI and Desktop adapters. It does not
 * mutate a global plugin registry or grant tools. A missing manifest is an
 * exact no-op so legacy skill discovery remains unchanged.
 */
import type { WorkspaceManifest } from './manifest.js';
import {
  inspectWorkspaceProfilePlugins,
  workspaceProfilePluginSkillIds,
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS,
  type WorkspaceProfilePluginCatalog,
} from './profilePlugins.js';
import {
  WORKSPACE_PROFILES,
  type WorkspaceProfileId,
} from './profiles.js';

export type WorkspaceSkillBundleSource = 'bundled' | 'profile-plugin' | 'capability-plugin';

export interface SelectedWorkspaceSkillBundle {
  id: string;
  source: WorkspaceSkillBundleSource;
  skillIds: string[];
  version?: string;
  skillsRoot?: string;
}

export interface UnavailableWorkspaceSkillBundle {
  id: string;
  source: 'manifest-pack' | 'active-capability';
  reason: string;
}

export interface WorkspaceSkillSelection {
  /** False means callers must preserve their pre-manifest discovery behavior. */
  managed: boolean;
  bundles: SelectedWorkspaceSkillBundle[];
  unavailable: UnavailableWorkspaceSkillBundle[];
  /** Additional standard-plugin roots selected for this task. */
  skillRoots: string[];
  /** Skills eligible for ambient listing/triggering after explicit disables. */
  ambientSkillIds: string[];
  disabledSkillIds: string[];
}

export interface WorkspaceSkillSelectionInput {
  manifest: Pick<WorkspaceManifest, 'capabilities' | 'skills'> | null | undefined;
  /** Capability ids already activated by the task-scoped capability resolver. */
  activeCapabilities?: readonly string[];
  /** Injectable package catalog snapshot for tests and long-lived hosts. */
  catalog?: WorkspaceProfilePluginCatalog;
}

/**
 * Library-backed profile packs declared by the profile presets themselves.
 *
 * Package-plugin packs are excluded because their inspected package assets are
 * authoritative. Every remaining preset pack is a stable ownership label;
 * starter skills remain explicit manifest selections, preserving the existing
 * runtime semantics of the bundled Engineering pack.
 */
export interface BundledWorkspaceSkillPackDefinition {
  id: string;
  profileIds: readonly WorkspaceProfileId[];
  label: string;
  description: string;
  skillIds: readonly string[];
}

export const BUNDLED_WORKSPACE_SKILL_PACKS: readonly BundledWorkspaceSkillPackDefinition[] =
  Object.freeze(deriveBundledWorkspaceSkillPacks().map((pack) => Object.freeze({
    ...pack,
    profileIds: Object.freeze([...pack.profileIds]),
    skillIds: Object.freeze([...pack.skillIds]),
  })));
export const BUNDLED_WORKSPACE_SKILL_PACK_IDS: ReadonlySet<string> = new Set(
  BUNDLED_WORKSPACE_SKILL_PACKS.map((pack) => pack.id),
);
const BUNDLED_WORKSPACE_SKILL_PACK_BY_ID = new Map(
  BUNDLED_WORKSPACE_SKILL_PACKS.map((pack) => [pack.id, pack]),
);
const PROFILE_PLUGIN_PACK_IDS: ReadonlySet<string> = new Set(
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS
    .filter((plugin) => plugin.kind === 'profile')
    .map((plugin) => plugin.id),
);
const CAPABILITY_PLUGIN_IDS: ReadonlySet<string> = new Set(
  WORKSPACE_PROFILE_PLUGIN_DEFINITIONS
    .filter((plugin) => plugin.kind === 'capability')
    .map((plugin) => plugin.id),
);

/** Resolve manifest and task-time selections without changing plugin state. */
export function resolveWorkspaceSkillSelection(
  input: WorkspaceSkillSelectionInput,
): WorkspaceSkillSelection {
  if (!input.manifest) return emptySelection();

  const manifest = input.manifest;
  const catalog = input.catalog ?? inspectWorkspaceProfilePlugins();
  const available = new Map(catalog.available.map((plugin) => [plugin.id, plugin]));
  const unavailable = new Map(catalog.unavailable.map((plugin) => [plugin.id, plugin.reason]));
  const disabledSkillIds = unique(manifest.skills.disabled);
  const disabledSkills = new Set(disabledSkillIds);
  const enabledCapabilities = new Set(
    manifest.capabilities.enabled.filter(
      (id) => !manifest.capabilities.disabled.includes(id),
    ),
  );
  const activeCapabilities = unique(input.activeCapabilities ?? []).filter(
    (id) => enabledCapabilities.has(id),
  );
  const activeCapabilitySet = new Set(activeCapabilities);
  const bundles: SelectedWorkspaceSkillBundle[] = [];
  const missing: UnavailableWorkspaceSkillBundle[] = [];

  for (const id of unique(manifest.skills.packs)) {
    const bundledPack = BUNDLED_WORKSPACE_SKILL_PACK_BY_ID.get(id);
    if (bundledPack) {
      bundles.push({ id, source: 'bundled', skillIds: [...bundledPack.skillIds] });
      continue;
    }
    if (CAPABILITY_PLUGIN_IDS.has(id)) {
      if (!activeCapabilitySet.has(id)) {
        missing.push({
          id,
          source: 'manifest-pack',
          reason: 'capability bundle requires task-time activation',
        });
      }
      continue;
    }
    if (PROFILE_PLUGIN_PACK_IDS.has(id)) {
      selectPluginBundle(id, 'profile-plugin', 'manifest-pack', available, unavailable, bundles, missing);
      continue;
    }
    missing.push({ id, source: 'manifest-pack', reason: 'unknown skill pack' });
  }

  for (const id of activeCapabilities) {
    if (!CAPABILITY_PLUGIN_IDS.has(id)) continue;
    selectPluginBundle(id, 'capability-plugin', 'active-capability', available, unavailable, bundles, missing);
  }

  const ambientSkillIds = unique([
    ...manifest.skills.enabled,
    ...bundles.flatMap((bundle) => bundle.skillIds),
  ]).filter((id) => !disabledSkills.has(id));

  return {
    managed: true,
    bundles,
    unavailable: missing,
    skillRoots: unique(
      bundles.flatMap((bundle) => bundle.skillsRoot ? [bundle.skillsRoot] : []),
    ),
    ambientSkillIds,
    disabledSkillIds,
  };
}

function deriveBundledWorkspaceSkillPacks(): BundledWorkspaceSkillPackDefinition[] {
  const packagePackIds = new Set<string>(
    WORKSPACE_PROFILE_PLUGIN_DEFINITIONS.map((definition) => definition.id),
  );
  const owners = new Map<string, {
    profileIds: WorkspaceProfileId[];
    labels: string[];
  }>();

  for (const profile of WORKSPACE_PROFILES) {
    for (const id of unique(profile.skills.packs)) {
      if (packagePackIds.has(id)) continue;
      const existing = owners.get(id) ?? { profileIds: [], labels: [] };
      existing.profileIds.push(profile.id);
      existing.labels.push(profile.label);
      owners.set(id, existing);
    }
  }

  return [...owners.entries()].map(([id, owner]) => ({
    id,
    profileIds: owner.profileIds,
    label: owner.labels.join(' / '),
    description: id === 'engineering'
      ? 'Bundled skills recommended for this workspace profile.'
      : owner.labels.length === 1
      ? `Bundled skills included with the ${owner.labels[0]} workspace profile.`
      : 'Bundled skills shared by workspace profile presets.',
    skillIds: [],
  }));
}

function selectPluginBundle(
  id: string,
  source: Extract<WorkspaceSkillBundleSource, 'profile-plugin' | 'capability-plugin'>,
  unavailableSource: UnavailableWorkspaceSkillBundle['source'],
  available: Map<string, WorkspaceProfilePluginCatalog['available'][number]>,
  unavailable: Map<string, string>,
  bundles: SelectedWorkspaceSkillBundle[],
  missing: UnavailableWorkspaceSkillBundle[],
): void {
  if (bundles.some((bundle) => bundle.id === id)) return;
  const plugin = available.get(id);
  if (!plugin) {
    missing.push({
      id,
      source: unavailableSource,
      reason: unavailable.get(id) ?? 'profile plugin is unavailable',
    });
    return;
  }
  bundles.push({
    id,
    source,
    skillIds: workspaceProfilePluginSkillIds(plugin),
    version: plugin.version,
    skillsRoot: plugin.skillsRoot,
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptySelection(): WorkspaceSkillSelection {
  return {
    managed: false,
    bundles: [],
    unavailable: [],
    skillRoots: [],
    ambientSkillIds: [],
    disabledSkillIds: [],
  };
}
