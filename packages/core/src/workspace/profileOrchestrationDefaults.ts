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
export const ORCHESTRATION_PLAN_ALIASES: Readonly<Partial<Record<WorkspaceProfileId, WorkspaceProfileId>>> = {
  'product-management': 'engineering',
  design: 'engineering',
  operations: 'engineering',
  consulting: 'research',
  legal: 'research',
  healthcare: 'research',
  finance: 'data-science',
  education: 'study',
  marketing: 'writing',
  sales: 'writing',
  people: 'writing',
};

export function resolveWorkspaceProfileOrchestrationDefaults(
  profileId: WorkspaceProfileId,
  options: ResolveWorkspaceProfileOrchestrationDefaultsOptions = {},
): WorkspaceProfileOrchestrationDefaults {
  try {
    const find = options.findPlan ?? findBundledOrchestrationProfile;
    // Resolve the profile's own plan first; an alias is only a fallback, so a
    // domain that later gains a bespoke plan starts using it automatically.
    const plan = find(profileId) ?? (
      ORCHESTRATION_PLAN_ALIASES[profileId] ? find(ORCHESTRATION_PLAN_ALIASES[profileId]!) : undefined
    );
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
