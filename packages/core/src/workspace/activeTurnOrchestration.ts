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
import { detectOrchestrationTaskSignals } from '../orchestration/profiles/taskSignals.js';
import { readPreferences } from '../session/preferences/preferencesStore.js';
import { loadWorkspaceManifest } from './manifest.js';
import { buildWorkspaceOnboardingSources } from './onboardingSources.js';
import { resolveWorkspaceSkillSelection } from './skillSelection.js';

export interface ActiveTurnOrchestrationResolution {
  plan: ResolvedWorkspaceOrchestrationPlan;
  taskSignalIds: string[];
  source: string;
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
    return {
      plan: resolveWorkspaceOrchestrationPlan(emptyInput()),
      taskSignalIds: [],
      source: 'preplanned',
    };
  }
  if ((input.parentDepth ?? 0) > 0) {
    return {
      plan: resolveWorkspaceOrchestrationPlan(emptyInput()),
      taskSignalIds: [],
      source: 'nested-agent',
    };
  }
  const manifest = loadWorkspaceManifest(input.workspaceRoot);
  if (!manifest) {
    return {
      plan: resolveWorkspaceOrchestrationPlan(emptyInput()),
      taskSignalIds: [],
      source: 'none',
    };
  }

  const sources = buildWorkspaceOnboardingSources(input.workspaceRoot);
  const profile = sources.orchestrationProfiles.entries.get(manifest.profile);
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
  const selectedSkills = resolveWorkspaceSkillSelection({
    manifest,
    activeCapabilities: [],
  });
  const taskSignalIds = [...detectOrchestrationTaskSignals(input.task)];
  const plan = resolveWorkspaceOrchestrationPlan({
    definition: profile?.definition,
    manifest,
    taskSignalIds: new Set(taskSignalIds),
    roleCatalog,
    installedSkillIds,
    workspaceSkillIds: new Set(selectedSkills.ambientSkillIds),
    capabilitySkillIds: new Set(input.activeCapabilitySkillIds ?? []),
    delegationPolicy: resolveDelegationPolicy(readPreferences(input.workspaceRoot)),
    runtimeLimits: {
      maxConcurrentChildren: getCliKnobs().maxConcurrentChildren,
    },
    parentDepth: input.parentDepth ?? 0,
  });

  return {
    plan,
    taskSignalIds,
    source: profile?.source.provenance ?? 'unavailable',
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
