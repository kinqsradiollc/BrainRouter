/**
 * Safe, read-only plan and selection preview for CLI/Desktop onboarding.
 *
 * This view contains catalog metadata and resolved IDs only. It never exposes
 * skill bodies, role prompts, secrets, paths, credentials, or live MCP payloads.
 */
import { findBundledOrchestrationProfile } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  findResolvedOrchestrationProfile,
  type ResolvedOrchestrationProfileCatalog,
  type ResolvedOrchestrationProfileSource,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import type { WorkspaceManifest } from './manifest.js';
import { getWorkspaceProfile } from './profiles.js';
import {
  buildWorkspaceSelectionCatalog,
  diagnoseWorkspaceToolSelectionMigration,
  type WorkspaceSelectionCatalog,
  type WorkspaceSelectionCatalogEntry,
} from './selectionCatalog.js';
import { resolveWorkspaceSkillSelection } from './skillSelection.js';
import { resolveWorkspaceToolSelection } from './toolProfiles.js';

export interface WorkspaceOnboardingCatalogRow extends WorkspaceSelectionCatalogEntry {
  selected: boolean;
  recommended: boolean;
  denied: boolean;
}

export interface WorkspaceOnboardingPreview {
  profileId: string;
  plan: {
    id: string;
    displayName: string;
    mode: 'off' | 'explicit' | 'adaptive';
    selectedStrategyId: string;
    selectionReason: 'mode-off' | 'setup-preview-fallback';
    source: ResolvedOrchestrationProfileSource;
    strategies: Array<{
      id: string;
      description: string;
      stages: Array<{
        id: string;
        executorKind: 'primary' | 'role';
        roleId?: string;
        skillIds: string[];
        optional: boolean;
        maxChildren: number;
      }>;
    }>;
  } | null;
  roles: {
    planAvailable: string[];
    manifestAvailable: string[];
    disabled: string[];
    effective: string[];
  };
  skills: {
    effective: string[];
    unavailablePacks: Array<{ id: string; reason: string }>;
  };
  tools: {
    mode: 'legacy-groups' | 'explicit-catalog';
    selectedGroups: string[];
    effectiveToolIds: string[];
    effectiveExtensionIds: string[];
    deniedIds: string[];
    migrationRequired: boolean;
  };
  ceilings: {
    planMaxParallel: number;
    manifestMaxParallel: number;
    effectiveMaxParallel: number;
  };
  catalogFingerprint: string;
  catalog: WorkspaceOnboardingCatalogRow[];
}

export function buildWorkspaceOnboardingPreview(
  manifest: WorkspaceManifest,
  catalog: WorkspaceSelectionCatalog = buildWorkspaceSelectionCatalog(),
  orchestrationProfiles?: ResolvedOrchestrationProfileCatalog,
): WorkspaceOnboardingPreview {
  const resolvedPlan = orchestrationProfiles
    ? findResolvedOrchestrationProfile(orchestrationProfiles, manifest.profile)
    : undefined;
  const plan = orchestrationProfiles
    ? resolvedPlan?.definition
    : findBundledOrchestrationProfile(manifest.profile);
  const planSource: ResolvedOrchestrationProfileSource = resolvedPlan?.source
    ?? { kind: 'bundled', provenance: 'bundled' };
  const preset = getWorkspaceProfile(manifest.profile);
  const disabledRoles = new Set(manifest.orchestration.disabledRoles);
  const planRoles = new Set(plan?.rolePolicy.availableRoles ?? []);
  const effectiveRoles = manifest.orchestration.availableRoles.filter(
    (roleId) => planRoles.has(roleId) && !disabledRoles.has(roleId),
  );
  const skillSelection = resolveWorkspaceSkillSelection({ manifest });
  const toolSelection = resolveWorkspaceToolSelection({ manifest });
  const migration = diagnoseWorkspaceToolSelectionMigration(manifest, catalog);

  const selectedGroups = new Set(manifest.tools.profiles);
  const selectedTools = new Set(manifest.tools.enabled ?? []);
  const selectedCapabilities = new Set(manifest.capabilities.enabled);
  const selectedPacks = new Set(manifest.skills.packs);
  const selectedSkills = new Set(manifest.skills.enabled);
  const deniedTools = toolSelection.deniedIds;
  const disabledCapabilities = new Set(manifest.capabilities.disabled);
  const disabledSkills = new Set(manifest.skills.disabled);
  const recommendedGroups = new Set(preset?.tools.profiles ?? []);
  const recommendedRoles = new Set(preset?.orchestration.availableRoles ?? []);
  const recommendedCapabilities = new Set(preset?.capabilities.enabled ?? []);
  const recommendedPacks = new Set(preset?.skills.packs ?? []);
  const recommendedSkills = new Set(preset?.skills.enabled ?? []);

  return {
    profileId: manifest.profile,
    plan: plan
      ? {
          id: plan.id,
          displayName: plan.displayName,
          mode: manifest.orchestration.mode,
          selectedStrategyId: plan.fallbackStrategyId,
          selectionReason: manifest.orchestration.mode === 'off'
            ? 'mode-off'
            : 'setup-preview-fallback',
          source: planSource,
          strategies: plan.strategies.map((strategy) => ({
            id: strategy.id,
            description: strategy.description,
            stages: strategy.stages.map((stage) => ({
              id: stage.id,
              executorKind: stage.executor.kind,
              ...(stage.executor.kind === 'role'
                ? { roleId: stage.executor.roleId }
                : {}),
              skillIds: [...stage.skillIds],
              optional: stage.optional,
              maxChildren: stage.executor.kind === 'role'
                ? Math.min(stage.fanOut?.max ?? 1, manifest.orchestration.maxParallel)
                : 0,
            })),
          })),
        }
      : null,
    roles: {
      planAvailable: [...planRoles],
      manifestAvailable: [...manifest.orchestration.availableRoles],
      disabled: [...disabledRoles],
      effective: effectiveRoles,
    },
    skills: {
      effective: [...skillSelection.ambientSkillIds],
      unavailablePacks: skillSelection.unavailable.map(({ id, reason }) => ({ id, reason })),
    },
    tools: {
      mode: toolSelection.mode,
      selectedGroups: [...toolSelection.activeProfileIds],
      effectiveToolIds: [...toolSelection.allowedToolIds]
        .filter((id) => !toolSelection.deniedIds.has(id)),
      effectiveExtensionIds: [...toolSelection.allowedExtensionIds]
        .filter((id) => !toolSelection.deniedIds.has(id)),
      deniedIds: [...toolSelection.deniedIds],
      migrationRequired: migration.required,
    },
    ceilings: {
      planMaxParallel: plan?.limits.maxParallel ?? 0,
      manifestMaxParallel: manifest.orchestration.maxParallel,
      effectiveMaxParallel: plan
        ? Math.min(plan.limits.maxParallel, manifest.orchestration.maxParallel)
        : 0,
    },
    catalogFingerprint: catalog.fingerprint,
    catalog: catalog.entries.map((entry) => {
      const roleBlockedByPlan = entry.kind === 'role'
        && (manifest.orchestration.mode === 'off' || !planRoles.has(entry.id));
      const capabilityBlockedByProfile = entry.kind === 'capability'
        && preset?.id !== 'custom'
        && !recommendedCapabilities.has(entry.id);
      const selectionBlocked = roleBlockedByPlan || capabilityBlockedByProfile;
      return {
        ...entry,
        selectable: entry.selectable && !selectionBlocked,
        ...(selectionBlocked && !entry.blockedReason
          ? {
              blockedReason: roleBlockedByPlan
                ? manifest.orchestration.mode === 'off'
                  ? 'Delegation is off for this workspace.'
                  : 'Not available in the selected orchestration plan.'
                : 'Not contributed for the selected workspace profile.',
            }
          : {}),
        selected: entry.kind === 'role'
          ? manifest.orchestration.availableRoles.includes(entry.id)
          : entry.kind === 'capability'
            ? selectedCapabilities.has(entry.id)
          : entry.kind === 'tool-group'
            ? selectedGroups.has(entry.id)
            : entry.kind === 'tool'
              ? selectedTools.has(entry.id)
              : entry.kind === 'skill-pack'
                ? selectedPacks.has(entry.id)
                : entry.kind === 'skill'
                  ? selectedSkills.has(entry.id)
                  : false,
        recommended: entry.kind === 'role'
          ? recommendedRoles.has(entry.id)
          : entry.kind === 'capability'
            ? recommendedCapabilities.has(entry.id)
          : entry.kind === 'tool-group'
            ? recommendedGroups.has(entry.id)
            : entry.kind === 'skill-pack'
              ? recommendedPacks.has(entry.id)
              : entry.kind === 'skill'
                ? recommendedSkills.has(entry.id)
                : false,
        denied: entry.kind === 'role'
          ? disabledRoles.has(entry.id)
          : entry.kind === 'capability'
            ? disabledCapabilities.has(entry.id)
          : entry.kind === 'skill'
            ? disabledSkills.has(entry.id)
            : (entry.kind === 'tool' || entry.kind === 'tool-group')
              ? deniedTools.has(entry.id)
              : false,
      };
    }),
  };
}
