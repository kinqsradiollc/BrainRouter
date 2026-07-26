/**
 * Workspace-onboarding defaults derived from bundled orchestration plans.
 *
 * The TypeScript profile rows remain a compatibility source for one release,
 * but new drafts prefer the same validated package data the resolver uses.
 */
import { findBundledOrchestrationProfile } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  type WorkspaceProfileId,
  type WorkspaceProfilePreset,
} from './profiles.js';

export interface WorkspaceProfileOrchestrationDefaults {
  mode: 'off' | 'explicit' | 'adaptive';
  availableRoles: string[];
  disabledRoles: string[];
  maxParallel: number;
  source: 'orchestration-profile' | 'typescript-compatibility';
  planId: string | null;
}

export function resolveWorkspaceProfileOrchestrationDefaults(
  profileId: WorkspaceProfileId,
): WorkspaceProfileOrchestrationDefaults {
  try {
    const plan = findBundledOrchestrationProfile(profileId);
    if (plan) {
      return {
        mode: plan.defaultMode,
        availableRoles: [...plan.rolePolicy.availableRoles],
        disabledRoles: [...plan.rolePolicy.disabledRoles],
        maxParallel: plan.limits.maxParallel,
        source: 'orchestration-profile',
        planId: plan.id,
      };
    }
  } catch {
    // Package corruption is diagnosed by catalog tests. Onboarding remains
    // usable through the one-release compatibility source.
  }
  const preset = getWorkspaceProfile(profileId) ?? getWorkspaceProfile('custom')!;
  return {
    mode: preset.orchestration.mode,
    availableRoles: [...preset.orchestration.availableRoles],
    disabledRoles: [...preset.orchestration.disabledRoles],
    maxParallel: preset.orchestration.maxParallel,
    source: 'typescript-compatibility',
    planId: null,
  };
}

/** Safe profile rows for CLI/Desktop onboarding without duplicate plan defaults. */
export function workspaceProfilesForOnboarding(): WorkspaceProfilePreset[] {
  return WORKSPACE_PROFILES.map((preset) => {
    const defaults = resolveWorkspaceProfileOrchestrationDefaults(preset.id);
    return {
      ...preset,
      persona: {
        default: preset.persona.default,
        enabled: [...preset.persona.enabled],
      },
      orchestration: {
        mode: defaults.mode,
        availableRoles: defaults.availableRoles,
        disabledRoles: defaults.disabledRoles,
        maxParallel: defaults.maxParallel,
      },
      agents: {
        default: preset.agents.default,
        enabled: [...preset.agents.enabled],
      },
      capabilities: { enabled: [...preset.capabilities.enabled] },
      skills: {
        packs: [...preset.skills.packs],
        enabled: [...preset.skills.enabled],
      },
      tools: { profiles: [...preset.tools.profiles] },
      memory: {
        tags: [...preset.memory.tags],
        captureHint: preset.memory.captureHint,
      },
    };
  });
}
