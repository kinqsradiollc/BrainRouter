/**
 * Resolve one saved workspace orchestration profile at the live root-turn
 * boundary. This slice is read-only: it publishes the narrowed plan for trace
 * and later stage execution, but cannot launch a child or mutate workspace
 * configuration.
 */
import { getCliKnobs } from '../config/config.js';
import { loadRegistry } from '../orchestration/agents/agentRegistry.js';
import { resolveDelegationPolicy } from '../orchestration/delegation/delegationPolicy.js';
import { orchestrationProfileRoleReference } from '../orchestration/profiles/orchestrationProfileCatalog.js';
import {
  resolveWorkspaceOrchestrationPlan,
  type ResolvedWorkspaceOrchestrationPlan,
} from '../orchestration/profiles/orchestrationProfileResolver.js';
// ADR-040 A40-8 — the adaptive-selection eligibility, safe baseline, and the
// corpus gate. Wired here at the live root-turn seam so the gate is a runtime
// INVARIANT and its state is surfaced, not merely a constant in an unwired file.
import {
  adaptiveEligibility,
  adaptiveDiagnostics,
  assertCorpusGateHonored,
  type AdaptiveDiagnostics,
  type AdaptiveEligibilityInput,
} from '../orchestration/execution/adaptiveActivation.js';
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';
import { readPreferences } from '../session/preferences/preferencesStore.js';
import { loadWorkspaceManifest, type WorkspaceManifest } from './manifest.js';
import { buildWorkspaceOnboardingSources } from './onboardingSources.js';
import { resolveOrchestrationPlanIdentity } from './orchestrationPlanIdentity.js';
import { resolveWorkspaceProfileOrchestrationDefaults } from './profileOrchestrationDefaults.js';
import { suggestWorkspaceProfile } from './profileSuggest.js';
import { getWorkspaceProfile, type WorkspaceProfileId } from './profiles.js';
import { resolveWorkspaceSkillSelection } from './skillSelection.js';

export interface ActiveTurnOrchestrationResolution {
  plan: ResolvedWorkspaceOrchestrationPlan;
  taskSignalIds: string[];
  source: string;
  /**
   * ADR-040 A40-8 — adaptive-selection eligibility + the corpus gate for this
   * turn. `defaultsGated` is surfaced (never inferred), and the finalizer below
   * enforces that while it is true no selection may move a system default.
   */
  adaptive: AdaptiveDiagnostics;
}

/**
 * ADR-040 A40-8 — attach the adaptive diagnostics and enforce the corpus gate.
 *
 * The gate guards CHANGING a system default, not honoring workspace config. The
 * resolver only ever selects a workspace-defined, signal-matched strategy (or an
 * explicit/fallback one), so this invariant holds today — asserting it makes the
 * gate live rather than a constant that a future change could quietly outgrow.
 */
function withAdaptive(
  plan: ResolvedWorkspaceOrchestrationPlan,
  taskSignalIds: string[],
  source: string,
  eligibilityInput: AdaptiveEligibilityInput,
): ActiveTurnOrchestrationResolution {
  const eligibility = adaptiveEligibility(eligibilityInput);
  const isFallback = plan.selectionSource === 'fallback';
  const adaptive = adaptiveDiagnostics({
    eligibility,
    explicitStrategyId: eligibilityInput.explicitStrategyId,
    selectedStrategyId: isFallback ? null : plan.strategyId,
    fallbackReason: isFallback && eligibility.eligible ? 'resolver-fallback' : undefined,
  });
  // A40-8 — enforce the corpus gate as a live invariant on the resolved plan.
  assertCorpusGateHonored({
    selectionSource: plan.selectionSource,
    matchedSignalCount: plan.matchedSignalIds.length,
  });
  return { plan, taskSignalIds, source, adaptive };
}

/**
 * The profile choice a never-onboarded workspace would have been offered, used
 * only to route this turn. Nothing is written to disk and no synthetic manifest
 * escapes this module — every other consumer still sees "no manifest".
 */
export interface InferredWorkspaceOrchestrationDefault {
  profile: WorkspaceProfileId;
  orchestration: WorkspaceManifest['orchestration'];
  skillIds: readonly string[];
}

export function resolveActiveTurnOrchestration(input: {
  workspaceRoot: string;
  task: string;
  activeCapabilitySkillIds?: readonly string[];
  parentDepth?: number;
  /**
   * The caller already chose this turn's workflow — a slash command that
   * assembled a review/commit prompt, or a latched skill. Signal detection reads
   * the whole assembled task, so a 60KB review prompt full of the words "bug",
   * "fix" and "implement" out-matches every narrow review pattern and the turn
   * gets planned as a delivery run. A pre-planned turn is the executor, not the
   * task to be planned.
   */
  preplanned?: boolean;
}): ActiveTurnOrchestrationResolution {
  if (input.preplanned === true) {
    return withAdaptive(
      resolveWorkspaceOrchestrationPlan(emptyInput()), [], 'preplanned',
      { topLevel: true, hasDefinition: false },
    );
  }
  if ((input.parentDepth ?? 0) > 0) {
    return withAdaptive(
      resolveWorkspaceOrchestrationPlan(emptyInput()), [], 'nested-agent',
      { topLevel: false, hasDefinition: false },
    );
  }
  const manifest = loadWorkspaceManifest(input.workspaceRoot);
  const inferred = manifest ? null : inferWorkspaceOrchestrationDefault(input.workspaceRoot);
  // A saved manifest is always the authority; inference is only reachable when
  // there is none. `source: 'none'` now means "unrecognized repository", which
  // is narrower than "not onboarded".
  const selection: Pick<WorkspaceManifest, 'profile' | 'orchestration'> | null = manifest
    ?? (inferred ? { profile: inferred.profile, orchestration: inferred.orchestration } : null);
  if (!selection) {
    return withAdaptive(
      resolveWorkspaceOrchestrationPlan(emptyInput()), [], 'none',
      { topLevel: true, hasDefinition: false },
    );
  }

  const sources = buildWorkspaceOnboardingSources(input.workspaceRoot);
  const identity = resolveOrchestrationPlanIdentity(selection.profile, {
    catalog: sources.orchestrationProfiles,
  });
  const roleCatalog = new Map(
    loadRegistry(input.workspaceRoot).flatMap((loaded) => {
      try {
        return [[loaded.def.id, orchestrationProfileRoleReference(loaded.def)] as const];
      } catch {
        return [];
      }
    }),
  );
  const installedSkillIds = new Set(
    sources.catalog.entries
      .filter((entry) => entry.kind === 'skill' && entry.selectable)
      .map((entry) => entry.id),
  );
  // Inferred skills feed the resolver's stage-eligibility check only. They are
  // deliberately not routed through `resolveWorkspaceSkillSelection`, so
  // ambient skill loading and the skill tool policy stay unmanaged.
  const workspaceSkillIds = manifest
    ? resolveWorkspaceSkillSelection({ manifest, activeCapabilities: [] }).ambientSkillIds
    : inferred?.skillIds ?? [];
  const taskSignalIds = [...detectOrchestrationTaskSignals(input.task)];
  const plan = resolveWorkspaceOrchestrationPlan({
    definition: identity.definition,
    manifest: selection,
    taskSignalIds: new Set(taskSignalIds),
    roleCatalog,
    installedSkillIds,
    workspaceSkillIds: new Set(workspaceSkillIds),
    capabilitySkillIds: new Set(input.activeCapabilitySkillIds ?? []),
    delegationPolicy: resolveDelegationPolicy(readPreferences(input.workspaceRoot)),
    runtimeLimits: {
      maxConcurrentChildren: getCliKnobs().maxConcurrentChildren,
    },
    parentDepth: input.parentDepth ?? 0,
  });

  if (!identity.definition) {
    return withAdaptive(plan, taskSignalIds, 'unavailable',
      { topLevel: true, hasDefinition: false, mode: selection.orchestration.mode });
  }
  return withAdaptive(
    plan,
    taskSignalIds,
    // Telemetry must never present an inferred default as a reviewed workspace
    // choice the user actually made.
    manifest ? identity.source?.provenance ?? 'unavailable' : 'inferred-default',
    { topLevel: true, hasDefinition: true, mode: selection.orchestration.mode },
  );
}

const inferredDefaults = new Map<string, InferredWorkspaceOrchestrationDefault | null>();

/**
 * Guess how a workspace that has never been onboarded should route, using the
 * same deterministic suggester `/init` and desktop onboarding use — so an
 * inferred workspace and an onboarded one land on the same profile.
 *
 * Returns null for `custom`: that plan is `mode: 'off'` with no roles, so
 * synthesizing it would be strictly worse than inferring nothing. An
 * unrecognized repository gets no plan because nothing about it was established.
 *
 * Memoized per root because the suggester scans the filesystem, and a
 * repository does not change shape mid-session.
 */
export function inferWorkspaceOrchestrationDefault(
  workspaceRoot: string,
): InferredWorkspaceOrchestrationDefault | null {
  const cached = inferredDefaults.get(workspaceRoot);
  if (cached !== undefined) return cached;
  const suggestion = suggestWorkspaceProfile(workspaceRoot);
  const inferred = suggestion.profile === 'custom'
    ? null
    : buildInferredDefault(suggestion.profile);
  inferredDefaults.set(workspaceRoot, inferred);
  return inferred;
}

/** Test seam: the memo is process-wide and temp workspaces reuse this module. */
export function resetInferredWorkspaceOrchestrationDefaults(): void {
  inferredDefaults.clear();
}

function buildInferredDefault(
  profileId: WorkspaceProfileId,
): InferredWorkspaceOrchestrationDefault {
  const defaults = resolveWorkspaceProfileOrchestrationDefaults(profileId);
  return {
    profile: profileId,
    orchestration: {
      mode: defaults.mode,
      availableRoles: [...defaults.availableRoles],
      disabledRoles: [...defaults.disabledRoles],
      maxParallel: defaults.maxParallel,
    },
    skillIds: [...(getWorkspaceProfile(profileId)?.skills.enabled ?? [])],
  };
}

function emptyInput(): Parameters<typeof resolveWorkspaceOrchestrationPlan>[0] {
  return {
    definition: null,
    manifest: null,
    taskSignalIds: new Set(),
    roleCatalog: new Map(),
    installedSkillIds: new Set(),
    workspaceSkillIds: new Set(),
    delegationPolicy: 'no-children',
    runtimeLimits: { maxConcurrentChildren: 0 },
  };
}
