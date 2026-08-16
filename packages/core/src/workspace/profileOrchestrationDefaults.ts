/**
 * Workspace-onboarding defaults derived from bundled orchestration plans.
 *
 * The TypeScript profile rows remain a compatibility source for one release,
 * but new drafts prefer the same validated package data the resolver uses.
 */
import type { OrchestrationProfileDefinition } from '../orchestration/profiles/orchestrationProfileDefinitionFile.js';
import { recordWorkspaceCompatibilityDiagnostics } from './compatibilityDiagnostics.js';
import {
  ORCHESTRATION_PLAN_ALIASES,
  resolveOrchestrationPlanIdentity,
} from './orchestrationPlanIdentity.js';
import {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  type WorkspaceProfileId,
  type WorkspaceProfilePreset,
} from './profiles.js';

export interface WorkspaceProfileOrchestrationDefaults {
  workspaceProfileId: WorkspaceProfileId;
  planProfileId: string | null;
  mode: 'off' | 'explicit' | 'adaptive';
  availableRoles: string[];
  disabledRoles: string[];
  maxParallel: number;
  source: 'orchestration-profile' | 'typescript-compatibility';
  /** @deprecated Compatibility alias for planProfileId. */
  planId: string | null;
}

export interface ResolveWorkspaceProfileOrchestrationDefaultsOptions {
  /** Test/package-validation seam; production always uses the bundled catalog. */
  findPlan?: (profileId: WorkspaceProfileId) => OrchestrationProfileDefinition | undefined;
}

/**
 * Domain profiles added in 0.4.19 share an orchestration plan with the profile
 * whose WORK SHAPE they match, rather than shipping eleven near-identical plans.
 *
 * An orchestration plan describes how work decomposes — bounded question then
 * fan-out then audit, or spec then build then verify. That shape is a property
 * of the work, not of the industry doing it: a legal obligation review and a
 * research question both decompose into evidence collection and citation audit.
 * Eleven plans differing only in vocabulary would be eleven files nobody reads,
 * and each would drift independently.
 *
 * A domain that genuinely needs a different shape gets its own plan file, and
 * that is the signal to add one — not the mere existence of a new profile.
 */
export { ORCHESTRATION_PLAN_ALIASES } from './orchestrationPlanIdentity.js';

export function resolveWorkspaceProfileOrchestrationDefaults(
  profileId: WorkspaceProfileId,
  options: ResolveWorkspaceProfileOrchestrationDefaultsOptions = {},
): WorkspaceProfileOrchestrationDefaults {
  try {
    const identity = resolveOrchestrationPlanIdentity(profileId, {
      ...(options.findPlan ? { findBundledPlan: options.findPlan } : {}),
    });
    const plan = identity.definition;
    if (plan) {
      return {
        workspaceProfileId: identity.workspaceProfileId,
        planProfileId: identity.planProfileId,
        mode: plan.defaultMode,
        availableRoles: [...plan.rolePolicy.availableRoles],
        disabledRoles: [...plan.rolePolicy.disabledRoles],
        maxParallel: plan.limits.maxParallel,
        source: 'orchestration-profile',
        planId: identity.planProfileId,
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
    workspaceProfileId: profileId,
    planProfileId: null,
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
