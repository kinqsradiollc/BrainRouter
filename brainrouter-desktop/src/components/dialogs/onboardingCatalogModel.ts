/** Pure, bounded renderer parser for Core's safe onboarding preview/catalog. */
export type OnboardingCatalogKind = 'tool-group' | 'tool' | 'skill-pack' | 'skill' | 'runtime-tool';

export interface OnboardingCatalogRow {
  id: string;
  kind: OnboardingCatalogKind;
  label: string;
  description: string;
  source: string;
  provenance: string;
  persistable: boolean;
  selectable: boolean;
  blockedReason?: string;
  expandsTo: string[];
  selected: boolean;
  recommended: boolean;
  denied: boolean;
}

export interface OnboardingPlanPreview {
  profileId: string;
  catalogFingerprint: string;
  catalog: OnboardingCatalogRow[];
  plan: {
    id: string;
    displayName: string;
    mode: 'off' | 'explicit' | 'adaptive';
    selectedStrategyId: string;
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
  roles: { effective: string[] };
  skills: { effective: string[] };
  tools: {
    effectiveToolIds: string[];
    effectiveExtensionIds: string[];
    deniedIds: string[];
  };
  ceilings: {
    planMaxParallel: number;
    manifestMaxParallel: number;
    effectiveMaxParallel: number;
  };
}

const DIGEST = /^[0-9a-f]{64}$/;
const KINDS = new Set<OnboardingCatalogKind>([
  'tool-group', 'tool', 'skill-pack', 'skill', 'runtime-tool',
]);

export function parseOnboardingPreview(value: unknown): OnboardingPlanPreview | null {
  if (!record(value) || !bounded(value.profileId, 128) ||
      typeof value.catalogFingerprint !== 'string' || !DIGEST.test(value.catalogFingerprint) ||
      !Array.isArray(value.catalog) || value.catalog.length > 512 ||
      !record(value.roles) || !record(value.skills) || !record(value.tools) || !record(value.ceilings)) return null;
  const catalog = value.catalog.map(parseCatalogRow);
  const effectiveRoles = stringList(value.roles.effective);
  const effectiveSkills = stringList(value.skills.effective);
  const effectiveToolIds = stringList(value.tools.effectiveToolIds);
  const effectiveExtensionIds = stringList(value.tools.effectiveExtensionIds);
  const deniedIds = stringList(value.tools.deniedIds);
  const ceilings = parseCeilings(value.ceilings);
  const plan = value.plan === null ? null : parsePlan(value.plan);
  if (catalog.some((row) => !row) || !effectiveRoles || !effectiveSkills ||
      !effectiveToolIds || !effectiveExtensionIds || !deniedIds || !ceilings ||
      (value.plan !== null && !plan)) return null;
  return {
    profileId: value.profileId,
    catalogFingerprint: value.catalogFingerprint,
    catalog: catalog as OnboardingCatalogRow[],
    plan,
    roles: { effective: effectiveRoles },
    skills: { effective: effectiveSkills },
    tools: { effectiveToolIds, effectiveExtensionIds, deniedIds },
    ceilings,
  };
}

function parseCatalogRow(value: unknown): OnboardingCatalogRow | null {
  if (!record(value) || !bounded(value.id, 128) || !KINDS.has(value.kind as OnboardingCatalogKind) ||
      !bounded(value.label, 256) || !bounded(value.description, 4096, true) ||
      !bounded(value.source, 128) || !bounded(value.provenance, 256) ||
      typeof value.persistable !== 'boolean' || typeof value.selectable !== 'boolean' ||
      typeof value.selected !== 'boolean' || typeof value.recommended !== 'boolean' ||
      typeof value.denied !== 'boolean') return null;
  const expandsTo = value.expandsTo === undefined ? [] : stringList(value.expandsTo);
  if (!expandsTo || !(value.blockedReason === undefined || bounded(value.blockedReason, 2048))) return null;
  return {
    id: value.id,
    kind: value.kind as OnboardingCatalogKind,
    label: value.label,
    description: value.description,
    source: value.source,
    provenance: value.provenance,
    persistable: value.persistable,
    selectable: value.selectable,
    ...(value.blockedReason ? { blockedReason: value.blockedReason } : {}),
    expandsTo,
    selected: value.selected,
    recommended: value.recommended,
    denied: value.denied,
  };
}

function parsePlan(value: unknown): NonNullable<OnboardingPlanPreview['plan']> | null {
  if (!record(value) || !bounded(value.id, 128) || !bounded(value.displayName, 256) ||
      !(value.mode === 'off' || value.mode === 'explicit' || value.mode === 'adaptive') ||
      !bounded(value.selectedStrategyId, 128) || !Array.isArray(value.strategies) ||
      value.strategies.length > 32) return null;
  const strategies = value.strategies.map((candidate) => {
    if (!record(candidate) || !bounded(candidate.id, 128) ||
        !bounded(candidate.description, 2048, true) || !Array.isArray(candidate.stages) ||
        candidate.stages.length > 32) return null;
    const stages = candidate.stages.map((stage) => {
      if (!record(stage) || !bounded(stage.id, 128) ||
          !(stage.executorKind === 'primary' || stage.executorKind === 'role') ||
          typeof stage.optional !== 'boolean' || !Number.isSafeInteger(stage.maxChildren) ||
          Number(stage.maxChildren) < 0 || Number(stage.maxChildren) > 32) return null;
      const skillIds = stringList(stage.skillIds);
      if (!skillIds || (stage.executorKind === 'role' && !bounded(stage.roleId, 128))) return null;
      return {
        id: stage.id,
        executorKind: stage.executorKind,
        ...(stage.executorKind === 'role' ? { roleId: String(stage.roleId) } : {}),
        skillIds,
        optional: stage.optional,
        maxChildren: Number(stage.maxChildren),
      };
    });
    return stages.some((stage) => !stage) ? null : {
      id: candidate.id,
      description: candidate.description,
      stages: stages as NonNullable<OnboardingPlanPreview['plan']>['strategies'][number]['stages'],
    };
  });
  if (strategies.some((strategy) => !strategy)) return null;
  return {
    id: value.id,
    displayName: value.displayName,
    mode: value.mode,
    selectedStrategyId: value.selectedStrategyId,
    strategies: strategies as NonNullable<OnboardingPlanPreview['plan']>['strategies'],
  };
}

function parseCeilings(value: Record<string, unknown>): OnboardingPlanPreview['ceilings'] | null {
  const values = [
    value.planMaxParallel,
    value.manifestMaxParallel,
    value.effectiveMaxParallel,
  ];
  if (values.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0 || Number(entry) > 32)) return null;
  return {
    planMaxParallel: Number(values[0]),
    manifestMaxParallel: Number(values[1]),
    effectiveMaxParallel: Number(values[2]),
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 512 ||
      value.some((entry) => !bounded(entry, 256))) return null;
  return value as string[];
}

function bounded(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).length <= maxBytes;
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
