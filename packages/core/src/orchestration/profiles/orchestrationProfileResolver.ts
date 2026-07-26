/**
 * P23-3 pure orchestration-profile preview resolver.
 *
 * This module selects and narrows an already validated plan. It does not launch
 * children, mutate a manifest, or make profile JSON authoritative at runtime.
 * Every child stage must survive the workspace, catalog, skill, delegation,
 * and runtime-capacity intersections before it can appear in the preview.
 */
import type { WorkspaceManifest } from '../../workspace/manifest.js';
import {
  evaluateDelegationGate,
  type DelegationPolicy,
} from '../delegation/delegationPolicy.js';
import type {
  OrchestrationProfileDefinition,
  OrchestrationProfileRoleReference,
  OrchestrationProfileStage,
  OrchestrationProfileStrategy,
} from './orchestrationProfileDefinitionFile.js';

export type OrchestrationSelectionSource = 'explicit' | 'deterministic' | 'fallback';

export type OrchestrationResolutionReasonCode =
  | 'no-plan'
  | 'no-manifest'
  | 'invalid-plan'
  | 'profile-plan-mismatch'
  | 'mode-off'
  | 'explicit-mode-primary'
  | 'explicit-strategy-unavailable'
  | 'no-eligible-signal-match'
  | 'fallback-selected'
  | 'role-unavailable'
  | 'skill-unavailable'
  | 'delegation-disabled'
  | 'parallel-capacity-unavailable';

export interface OrchestrationResolutionDiagnostic {
  code: OrchestrationResolutionReasonCode;
  strategyId?: string;
  stageId?: string;
  referenceId?: string;
}

export interface OrchestrationRuntimeLimits {
  /** Non-positive values retain the existing CLI meaning of "uncapped". */
  maxConcurrentChildren: number;
  /** Live provider capacity. Zero means no child slot is currently available. */
  providerAvailableSlots?: number;
}

export interface WorkspaceOrchestrationResolutionInput {
  definition?: OrchestrationProfileDefinition | null;
  manifest?: Pick<WorkspaceManifest, 'profile' | 'orchestration'> | null;
  taskSignalIds: ReadonlySet<string>;
  roleCatalog: ReadonlyMap<string, OrchestrationProfileRoleReference>;
  installedSkillIds: ReadonlySet<string>;
  workspaceSkillIds: ReadonlySet<string>;
  /** Task-scoped skills contributed by active workspace capabilities. */
  capabilitySkillIds?: ReadonlySet<string>;
  delegationPolicy: DelegationPolicy;
  runtimeLimits: OrchestrationRuntimeLimits;
  explicitStrategyId?: string;
  parentDepth?: number;
}

export interface ResolvedOrchestrationStage {
  id: string;
  executor: OrchestrationProfileStage['executor'];
  after: string[];
  objective: string;
  skillIds: string[];
  fanOut?: { min: number; max: number };
  optional: boolean;
  expectedOutput?: {
    contractId: string;
    requiredSections: string[];
  };
  requiresApproval: boolean;
}

export interface ResolvedWorkspaceOrchestrationPlan {
  orchestrationProfileId: string | null;
  strategyId: string | null;
  selectionSource: OrchestrationSelectionSource;
  matchedSignalIds: string[];
  stages: ResolvedOrchestrationStage[];
  skippedStages: OrchestrationResolutionDiagnostic[];
  effectiveParallel: number;
  diagnostics: OrchestrationResolutionDiagnostic[];
  /** P23-3 is preview-only; P23-3a owns the activation lifecycle gate. */
  activation: 'preview';
}

interface StrategyPreview {
  available: boolean;
  stages: ResolvedOrchestrationStage[];
  skippedStages: OrchestrationResolutionDiagnostic[];
  diagnostics: OrchestrationResolutionDiagnostic[];
}

/** Resolve a deterministic, authority-narrowed preview or direct-primary fallback. */
export function resolveWorkspaceOrchestrationPlan(
  input: WorkspaceOrchestrationResolutionInput,
): ResolvedWorkspaceOrchestrationPlan {
  if (!input.definition) {
    return directPrimaryFallback('no-plan');
  }
  if (!input.manifest) {
    return directPrimaryFallback('no-manifest');
  }
  if (input.definition.id !== input.manifest.profile) {
    return directPrimaryFallback('profile-plan-mismatch');
  }

  const definition = input.definition;
  const effectiveParallel = effectivePlanParallelLimit(
    definition.limits.maxParallel,
    input.manifest.orchestration.maxParallel,
    input.runtimeLimits,
  );
  const fallback = definition.strategies.find(
    (strategy) => strategy.id === definition.fallbackStrategyId,
  );
  if (!fallback) {
    return directPrimaryFallback('invalid-plan');
  }
  const fallbackPreview = previewStrategy(fallback, input, effectiveParallel);
  if (!fallbackPreview.available || fallbackPreview.stages.some(
    (stage) =>
      stage.executor.kind !== 'primary' ||
      stage.skillIds.length > 0 ||
      stage.fanOut !== undefined ||
      stage.expectedOutput !== undefined,
  )) {
    return directPrimaryFallback('invalid-plan');
  }
  const fallbackResult = (
    diagnostics: OrchestrationResolutionDiagnostic[],
  ): ResolvedWorkspaceOrchestrationPlan => ({
    orchestrationProfileId: definition.id,
    strategyId: fallback.id,
    selectionSource: 'fallback',
    matchedSignalIds: [],
    stages: fallbackPreview.stages,
    skippedStages: fallbackPreview.skippedStages,
    effectiveParallel,
    diagnostics: [
      ...diagnostics,
      { code: 'fallback-selected', strategyId: fallback.id },
    ],
    activation: 'preview',
  });

  if (input.manifest.orchestration.mode === 'off') {
    return fallbackResult([{ code: 'mode-off' }]);
  }

  if (input.explicitStrategyId) {
    const requested = definition.strategies.find(
      (strategy) => strategy.id === input.explicitStrategyId,
    );
    if (requested) {
      const requestedPreview = previewStrategy(requested, input, effectiveParallel);
      if (requestedPreview.available) {
        return resolvedStrategy(
          definition.id,
          requested,
          requestedPreview,
          'explicit',
          input.taskSignalIds,
          effectiveParallel,
        );
      }
      return fallbackResult([
        {
          code: 'explicit-strategy-unavailable',
          strategyId: input.explicitStrategyId,
        },
        ...requestedPreview.diagnostics,
      ]);
    }
    return fallbackResult([{
      code: 'explicit-strategy-unavailable',
      strategyId: input.explicitStrategyId,
    }]);
  }

  if (input.manifest.orchestration.mode === 'explicit') {
    return fallbackResult([{ code: 'explicit-mode-primary' }]);
  }

  const unavailableMatches: OrchestrationResolutionDiagnostic[] = [];
  for (const strategy of definition.strategies) {
    if (strategy.activation.explicitOnly) continue;
    const matched = strategy.activation.signals.filter((signal) =>
      input.taskSignalIds.has(signal));
    if (matched.length === 0) continue;
    const preview = previewStrategy(strategy, input, effectiveParallel);
    if (preview.available) {
      return resolvedStrategy(
        definition.id,
        strategy,
        preview,
        'deterministic',
        new Set(matched),
        effectiveParallel,
      );
    }
    unavailableMatches.push(...preview.diagnostics);
  }

  return fallbackResult([
    { code: 'no-eligible-signal-match' },
    ...unavailableMatches,
  ]);
}

function previewStrategy(
  strategy: OrchestrationProfileStrategy,
  input: WorkspaceOrchestrationResolutionInput,
  effectiveParallel: number,
): StrategyPreview {
  const stages: ResolvedOrchestrationStage[] = [];
  const skippedStages: OrchestrationResolutionDiagnostic[] = [];
  const diagnostics: OrchestrationResolutionDiagnostic[] = [];
  const manifestRoles = new Set(input.manifest?.orchestration.availableRoles ?? []);
  const disabledRoles = new Set(input.manifest?.orchestration.disabledRoles ?? []);
  const capabilitySkills = input.capabilitySkillIds ?? new Set<string>();
  const selectedSkills = new Set([
    ...input.workspaceSkillIds,
    ...capabilitySkills,
  ]);
  const effectiveSkills = new Set(
    [...selectedSkills].filter((skillId) => input.installedSkillIds.has(skillId)),
  );

  for (const stage of strategy.stages) {
    const unavailable = stageUnavailableReason(
      stage,
      input,
      effectiveParallel,
      manifestRoles,
      disabledRoles,
      effectiveSkills,
    );
    if (unavailable) {
      const diagnostic = {
        ...unavailable,
        strategyId: strategy.id,
        stageId: stage.id,
      };
      if (stage.optional) {
        skippedStages.push(diagnostic);
        continue;
      }
      diagnostics.push(diagnostic);
      return { available: false, stages: [], skippedStages, diagnostics };
    }

    const role = stage.executor.kind === 'role'
      ? input.roleCatalog.get(stage.executor.roleId)
      : undefined;
    const gate = role
      ? evaluateDelegationGate({
          policy: input.delegationPolicy,
          childAccess: role.defaultAccess,
          depth: input.parentDepth ?? 0,
        })
      : 'allow';
    stages.push({
      id: stage.id,
      executor: { ...stage.executor },
      after: [...stage.after],
      objective: stage.objective,
      skillIds: [...stage.skillIds],
      ...(stage.fanOut
        ? {
            fanOut: {
              min: stage.fanOut.min,
              max: Math.min(stage.fanOut.max, effectiveParallel),
            },
          }
        : {}),
      optional: stage.optional,
      ...(stage.expectedOutput
        ? {
            expectedOutput: {
              contractId: stage.expectedOutput.contractId,
              requiredSections: [...stage.expectedOutput.requiredSections],
            },
          }
        : {}),
      requiresApproval: gate === 'ask',
    });
  }

  return { available: true, stages, skippedStages, diagnostics };
}

function stageUnavailableReason(
  stage: OrchestrationProfileStage,
  input: WorkspaceOrchestrationResolutionInput,
  effectiveParallel: number,
  manifestRoles: ReadonlySet<string>,
  disabledRoles: ReadonlySet<string>,
  effectiveSkills: ReadonlySet<string>,
): OrchestrationResolutionDiagnostic | null {
  const missingSkill = stage.skillIds.find((skillId) => !effectiveSkills.has(skillId));
  if (missingSkill) return { code: 'skill-unavailable', referenceId: missingSkill };
  if (stage.executor.kind === 'primary') return null;

  const roleId = stage.executor.roleId;
  const role = input.roleCatalog.get(roleId);
  if (!role || !manifestRoles.has(roleId) || disabledRoles.has(roleId)) {
    return { code: 'role-unavailable', referenceId: roleId };
  }
  const gate = evaluateDelegationGate({
    policy: input.delegationPolicy,
    childAccess: role.defaultAccess,
    depth: input.parentDepth ?? 0,
  });
  if (gate === 'deny') {
    return { code: 'delegation-disabled', referenceId: roleId };
  }
  if ((stage.fanOut?.min ?? 1) > effectiveParallel) {
    return { code: 'parallel-capacity-unavailable', referenceId: roleId };
  }
  return null;
}

function resolvedStrategy(
  orchestrationProfileId: string,
  strategy: OrchestrationProfileStrategy,
  preview: StrategyPreview,
  selectionSource: Exclude<OrchestrationSelectionSource, 'fallback'>,
  signals: ReadonlySet<string>,
  effectiveParallel: number,
): ResolvedWorkspaceOrchestrationPlan {
  return {
    orchestrationProfileId,
    strategyId: strategy.id,
    selectionSource,
    matchedSignalIds: strategy.activation.signals.filter((signal) => signals.has(signal)),
    stages: preview.stages,
    skippedStages: preview.skippedStages,
    effectiveParallel,
    diagnostics: preview.diagnostics,
    activation: 'preview',
  };
}

function directPrimaryFallback(
  code: Extract<
    OrchestrationResolutionReasonCode,
    'no-plan' | 'no-manifest' | 'invalid-plan' | 'profile-plan-mismatch'
  >,
): ResolvedWorkspaceOrchestrationPlan {
  return {
    orchestrationProfileId: null,
    strategyId: null,
    selectionSource: 'fallback',
    matchedSignalIds: [],
    stages: [{
      id: 'direct-primary',
      executor: { kind: 'primary' },
      after: [],
      objective: 'Continue directly on the primary agent.',
      skillIds: [],
      optional: false,
      requiresApproval: false,
    }],
    skippedStages: [],
    effectiveParallel: 0,
    diagnostics: [{ code }, { code: 'fallback-selected' }],
    activation: 'preview',
  };
}

function effectivePlanParallelLimit(
  planLimit: number,
  manifestLimit: number,
  runtime: OrchestrationRuntimeLimits,
): number {
  const ceilings = [planLimit, manifestLimit];
  if (Number.isFinite(runtime.maxConcurrentChildren) && runtime.maxConcurrentChildren > 0) {
    ceilings.push(Math.floor(runtime.maxConcurrentChildren));
  }
  if (runtime.providerAvailableSlots !== undefined) {
    ceilings.push(
      Number.isFinite(runtime.providerAvailableSlots)
        ? Math.max(0, Math.floor(runtime.providerAvailableSlots))
        : 0,
    );
  }
  return Math.max(0, Math.min(...ceilings));
}
