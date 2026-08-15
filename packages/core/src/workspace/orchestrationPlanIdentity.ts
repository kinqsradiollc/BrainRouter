/**
 * ADR-040 A40-1 workspace-to-plan identity policy.
 *
 * Workspace profiles own domain authority. A plan profile owns only a reusable
 * work shape, so an alias is accepted solely from this trusted bundled mapping.
 * Source-catalog exact claims retain precedence and invalid claims fail closed
 * instead of being hidden by an alias.
 */
import {
  findBundledOrchestrationProfile,
} from '../orchestration/profiles/orchestrationProfileCatalog.js';
import type {
  OrchestrationProfileDefinition,
} from '../orchestration/profiles/orchestrationProfileDefinitionFile.js';
import type {
  ResolvedOrchestrationProfileCatalog,
  ResolvedOrchestrationProfileSource,
} from '../orchestration/profiles/orchestrationProfileSources.js';
import type { WorkspaceProfileId } from './profiles.js';

/**
 * Reviewed work-shape aliases. An alias target is always loaded from bundled
 * package data; an override at the target ID cannot change another profile.
 */
export const ORCHESTRATION_PLAN_ALIASES: Readonly<
  Partial<Record<WorkspaceProfileId, WorkspaceProfileId>>
> = Object.freeze({
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
});

export type OrchestrationPlanIdentityResolution =
  | 'exact'
  | 'exact-unavailable'
  | 'bundled-alias'
  | 'no-plan';

export interface ResolvedOrchestrationPlanIdentity {
  workspaceProfileId: WorkspaceProfileId;
  planProfileId: string | null;
  definition?: OrchestrationProfileDefinition;
  source?: ResolvedOrchestrationProfileSource;
  resolution: OrchestrationPlanIdentityResolution;
}

export interface ResolveOrchestrationPlanIdentityOptions {
  catalog?: ResolvedOrchestrationProfileCatalog;
  /** Package-validation seam; production always reads bundled package data. */
  findBundledPlan?: (profileId: WorkspaceProfileId) => OrchestrationProfileDefinition | undefined;
}

/**
 * Private capability proof for definitions loaded through the production
 * bundled-plan boundary. Object identity prevents a structurally identical
 * caller-authored clone from inheriting alias authority. The trusted definition
 * is recursively frozen before it is returned, closing mutation and accessor
 * check/use gaps at the public resolver boundary.
 */
const TRUSTED_BUNDLED_ALIAS_PROOFS = new WeakMap<
  OrchestrationProfileDefinition,
  Set<WorkspaceProfileId>
>();

/** Resolve exact source precedence, then one trusted bundled alias, or no plan. */
export function resolveOrchestrationPlanIdentity(
  workspaceProfileId: WorkspaceProfileId,
  options: ResolveOrchestrationPlanIdentityOptions = {},
): ResolvedOrchestrationPlanIdentity {
  const catalog = options.catalog;
  if (catalog) {
    const exact = catalog.entries.get(workspaceProfileId);
    if (exact) {
      if (
        exact.id !== workspaceProfileId
        || exact.definition.id !== workspaceProfileId
      ) {
        return unavailableIdentity(workspaceProfileId);
      }
      return resolvedIdentity(
        workspaceProfileId,
        exact.definition,
        exact.source,
        'exact',
      );
    }
    if (catalog.unavailableIds.has(workspaceProfileId)) {
      return unavailableIdentity(workspaceProfileId);
    }
  }

  const findBundled = options.findBundledPlan ?? findBundledOrchestrationProfile;
  if (!catalog) {
    const exact = readBundledDefinition(findBundled, workspaceProfileId);
    if (exact.status === 'invalid') return unavailableIdentity(workspaceProfileId);
    if (exact.definition) {
      return resolvedIdentity(
        workspaceProfileId,
        exact.definition,
        bundledSource(),
        'exact',
      );
    }
  }

  const alias = ORCHESTRATION_PLAN_ALIASES[workspaceProfileId];
  if (!alias) return missingIdentity(workspaceProfileId);
  const aliased = readBundledDefinition(findBundled, alias);
  if (aliased.status === 'invalid') return unavailableIdentity(workspaceProfileId);
  if (!aliased.definition) return missingIdentity(workspaceProfileId);
  const definition = options.findBundledPlan === undefined
    ? recordTrustedBundledAlias(workspaceProfileId, aliased.definition)
    : aliased.definition;
  return resolvedIdentity(
    workspaceProfileId,
    definition,
    bundledSource(),
    'bundled-alias',
  );
}

/** Accept only a declared alias definition resolved through the trusted host boundary. */
export function isTrustedBundledOrchestrationPlanAlias(
  workspaceProfileId: WorkspaceProfileId,
  definition: OrchestrationProfileDefinition,
): boolean {
  const alias = ORCHESTRATION_PLAN_ALIASES[workspaceProfileId];
  if (alias !== definition.id) return false;
  return Object.isFrozen(definition)
    && TRUSTED_BUNDLED_ALIAS_PROOFS.get(definition)?.has(workspaceProfileId) === true;
}

function recordTrustedBundledAlias(
  workspaceProfileId: WorkspaceProfileId,
  definition: OrchestrationProfileDefinition,
): OrchestrationProfileDefinition {
  const frozen = deepFreezeDefinition(definition);
  const proofs = TRUSTED_BUNDLED_ALIAS_PROOFS.get(frozen) ?? new Set();
  proofs.add(workspaceProfileId);
  TRUSTED_BUNDLED_ALIAS_PROOFS.set(frozen, proofs);
  return frozen;
}

function deepFreezeDefinition(
  definition: OrchestrationProfileDefinition,
): OrchestrationProfileDefinition {
  const pending: object[] = [definition];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(value);
  }
  return definition;
}

function readBundledDefinition(
  findBundled: (profileId: WorkspaceProfileId) => OrchestrationProfileDefinition | undefined,
  expectedId: WorkspaceProfileId,
): { status: 'valid' | 'invalid'; definition?: OrchestrationProfileDefinition } {
  try {
    const definition = findBundled(expectedId);
    if (!definition) return { status: 'valid' };
    return definition.id === expectedId
      ? { status: 'valid', definition }
      : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function resolvedIdentity(
  workspaceProfileId: WorkspaceProfileId,
  definition: OrchestrationProfileDefinition,
  source: ResolvedOrchestrationProfileSource,
  resolution: Extract<OrchestrationPlanIdentityResolution, 'exact' | 'bundled-alias'>,
): ResolvedOrchestrationPlanIdentity {
  return {
    workspaceProfileId,
    planProfileId: definition.id,
    definition,
    source,
    resolution,
  };
}

function unavailableIdentity(
  workspaceProfileId: WorkspaceProfileId,
): ResolvedOrchestrationPlanIdentity {
  return {
    workspaceProfileId,
    planProfileId: null,
    resolution: 'exact-unavailable',
  };
}

function missingIdentity(
  workspaceProfileId: WorkspaceProfileId,
): ResolvedOrchestrationPlanIdentity {
  return {
    workspaceProfileId,
    planProfileId: null,
    resolution: 'no-plan',
  };
}

function bundledSource(): ResolvedOrchestrationProfileSource {
  return { kind: 'bundled', provenance: 'bundled' };
}
