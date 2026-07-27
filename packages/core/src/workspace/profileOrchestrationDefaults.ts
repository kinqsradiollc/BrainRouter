/**
 * Workspace-onboarding defaults derived from bundled orchestration plans.
 *
 * The TypeScript profile rows remain a compatibility source for one release,
 * but new drafts prefer the same validated package data the resolver uses.
 */
import { findBundledOrchestrationProfile } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import type { OrchestrationProfileDefinition } from '../orchestration/profiles/orchestrationProfileDefinitionFile.js';
import { recordWorkspaceCompatibilityDiagnostics } from './compatibilityDiagnostics.js';
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

export interface ResolveWorkspaceProfileOrchestrationDefaultsOptions {
  /** Test/package-validation seam; production always uses the bundled catalog. */
  findPlan?: (profileId: WorkspaceProfileId) => OrchestrationProfileDefinition | undefined;
}

export function resolveWorkspaceProfileOrchestrationDefaults(
  profileId: WorkspaceProfileId,
  options: ResolveWorkspaceProfileOrchestrationDefaultsOptions = {},
): WorkspaceProfileOrchestrationDefaults {
  try {
    const plan = (options.findPlan ?? findBundledOrchestrationProfile)(profileId);
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
  recordWorkspaceCompatibilityDiagnostics('profile-orchestration-defaults', [{
    code: 'typescript_orchestration_defaults',
    surface: 'manifest',
    severity: 'info',
    source: 'bundled',
    message: 'TypeScript workspace-profile orchestration defaults supplied a compatibility fallback.',
  }]);
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
      capabilities: {
        available: [...preset.capabilities.available],
        recommended: [...preset.capabilities.recommended],
        enabled: [...preset.capabilities.recommended],
      },
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
