/**
 * B3 — advisory workspace-profile serving recommendations.
 *
 * This pure domain resolver intersects the shared profile presets with a live,
 * caller-supplied catalog snapshot. It returns only packs, capabilities,
 * personas, and starter skills that can actually be served. The result is
 * preference data for onboarding; it never grants tools, roles, or access.
 */
import {
  getWorkspaceProfile,
  type WorkspaceProfileId,
} from './profiles.js';
import type {
  AvailableWorkspaceProfilePlugin,
  WorkspaceProfilePluginCatalog,
} from './profilePlugins.js';
import { BUNDLED_WORKSPACE_SKILL_PACK_IDS } from './skillSelection.js';

export interface WorkspaceProfileServingAvailability {
  profilePlugins: WorkspaceProfilePluginCatalog;
  personaIds: readonly string[];
  skillIds: readonly string[];
}

export interface RecommendedWorkspaceSkillPack {
  id: string;
  source: 'bundled' | 'profile-plugin';
  version?: string;
  skillIds: string[];
}

export interface RecommendedWorkspaceCapability {
  id: string;
  version: string;
  skillIds: string[];
}

export type WorkspaceProfileRecommendationItemKind =
  | 'skill-pack'
  | 'capability'
  | 'persona'
  | 'skill';

export interface UnavailableWorkspaceProfileRecommendationItem {
  kind: WorkspaceProfileRecommendationItemKind;
  id: string;
  reason: string;
}

export interface WorkspaceProfileServingRecommendation {
  profile: {
    id: WorkspaceProfileId;
    label: string;
    description: string;
  };
  advisory: true;
  authorizationEffect: 'none';
  complete: boolean;
  persona: {
    default: string;
    enabled: string[];
  };
  /** @deprecated Client compatibility alias for `persona`. */
  agents: {
    default: string;
    enabled: string[];
  };
  skillPacks: RecommendedWorkspaceSkillPack[];
  capabilities: RecommendedWorkspaceCapability[];
  starterSkillIds: string[];
  unavailable: UnavailableWorkspaceProfileRecommendationItem[];
}

/**
 * Recommend the servable subset of one shared preset.
 *
 * Unknown profiles return undefined. Missing catalog items stay visible in the
 * `unavailable` diagnostics instead of being fabricated or treated as policy.
 */
export function recommendWorkspaceProfileServing(
  profileId: string,
  availability: WorkspaceProfileServingAvailability,
): WorkspaceProfileServingRecommendation | undefined {
  const preset = getWorkspaceProfile(profileId);
  if (!preset) return undefined;

  const availablePlugins = new Map<string, AvailableWorkspaceProfilePlugin>(
    availability.profilePlugins.available.map((plugin) => [plugin.id, plugin]),
  );
  const unavailablePlugins = new Map<string, string>(
    availability.profilePlugins.unavailable.map((plugin) => [plugin.id, plugin.reason]),
  );
  const availablePersonas = new Set(availability.personaIds);
  const availableSkills = new Set(availability.skillIds);
  const unavailable: UnavailableWorkspaceProfileRecommendationItem[] = [];

  const skillPacks = unique(preset.skills.packs).flatMap((id): RecommendedWorkspaceSkillPack[] => {
    if (BUNDLED_WORKSPACE_SKILL_PACK_IDS.has(id)) {
      return [{ id, source: 'bundled', skillIds: [] }];
    }
    const plugin = availablePlugins.get(id);
    if (plugin?.kind === 'profile') {
      return [profilePack(plugin)];
    }
    unavailable.push({
      kind: 'skill-pack',
      id,
      reason: unavailablePlugins.get(id) ?? 'profile skill pack is unavailable',
    });
    return [];
  });

  const capabilities = unique(preset.capabilities.recommended).flatMap(
    (id): RecommendedWorkspaceCapability[] => {
      const plugin = availablePlugins.get(id);
      if (plugin?.kind === 'capability') {
        return [{
          id,
          version: plugin.version,
          skillIds: [...plugin.skillIds],
        }];
      }
      unavailable.push({
        kind: 'capability',
        id,
        reason: unavailablePlugins.get(id) ?? 'capability pack is unavailable',
      });
      return [];
    },
  );

  const requestedPersonas = unique([
    preset.persona.default,
    ...preset.persona.enabled,
  ].filter(Boolean));
  const enabledPersonas = requestedPersonas.filter((id) => {
    if (availablePersonas.has(id)) return true;
    unavailable.push({ kind: 'persona', id, reason: 'persona is unavailable' });
    return false;
  });

  const starterSkillIds = unique(preset.skills.enabled).filter((id) => {
    if (availableSkills.has(id)) return true;
    unavailable.push({ kind: 'skill', id, reason: 'starter skill is unavailable' });
    return false;
  });

  return {
    profile: {
      id: preset.id,
      label: preset.label,
      description: preset.description,
    },
    advisory: true,
    authorizationEffect: 'none',
    complete: unavailable.length === 0,
    persona: {
      default: availablePersonas.has(preset.persona.default) ? preset.persona.default : '',
      enabled: enabledPersonas,
    },
    agents: {
      default: availablePersonas.has(preset.persona.default) ? preset.persona.default : '',
      enabled: enabledPersonas,
    },
    skillPacks,
    capabilities,
    starterSkillIds,
    unavailable,
  };
}

function profilePack(plugin: AvailableWorkspaceProfilePlugin): RecommendedWorkspaceSkillPack {
  return {
    id: plugin.id,
    source: 'profile-plugin',
    version: plugin.version,
    skillIds: [...plugin.skillIds],
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
