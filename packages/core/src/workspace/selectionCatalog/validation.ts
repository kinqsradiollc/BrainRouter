import {
  WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
  normalizeWorkspaceManifest,
  type WorkspaceManifest,
} from '../manifest.js';
import {
  WORKSPACE_SELECTION_STABLE_ID,
  type ReviewedWorkspaceSkillSelection,
  type ReviewedWorkspaceToolSelection,
  type WorkspaceSelectionCatalog,
  type WorkspaceSelectionCatalogKind,
  type WorkspaceSelectionReviewIssue,
  type WorkspaceSelectionReviewResult,
  type WorkspaceToolSelectionMigrationDiagnostic,
} from './types.js';

/** Validate a reviewed tool proposal against one exact catalog snapshot. */
export function validateReviewedWorkspaceToolSelection(
  proposal: ReviewedWorkspaceToolSelection,
  catalog: WorkspaceSelectionCatalog,
): WorkspaceSelectionReviewResult<{
  profiles: string[];
  enabled: string[];
  deny: string[];
}> {
  const issues: WorkspaceSelectionReviewIssue[] = [];
  const profiles = validateField(proposal.profiles, 'profiles', ['tool-group'], true, catalog, issues);
  const enabled = validateField(proposal.enabled, 'enabled', ['tool'], true, catalog, issues);
  const deny = validateField(proposal.deny, 'deny', ['tool-group', 'tool'], false, catalog, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { profiles, enabled, deny } };
}

/** Validate existing skill fields for the catalog-backed picker without reading skill bodies. */
export function validateReviewedWorkspaceSkillSelection(
  proposal: ReviewedWorkspaceSkillSelection,
  catalog: WorkspaceSelectionCatalog,
): WorkspaceSelectionReviewResult<{
  packs: string[];
  enabled: string[];
  disabled: string[];
}> {
  const issues: WorkspaceSelectionReviewIssue[] = [];
  const packs = validateField(proposal.packs, 'packs', ['skill-pack'], true, catalog, issues);
  const enabled = validateField(proposal.enabled, 'enabled', ['skill'], true, catalog, issues);
  const disabled = validateField(proposal.disabled, 'disabled', ['skill'], false, catalog, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { packs, enabled, disabled } };
}

/**
 * Convert v2 semantics only after a reviewed catalog snapshot is supplied.
 * Callers pass the fingerprint shown during review to reject stale saves.
 */
export function migrateWorkspaceManifestToolSelection(input: {
  manifest: WorkspaceManifest;
  reviewed: ReviewedWorkspaceToolSelection;
  catalog: WorkspaceSelectionCatalog;
  reviewedCatalogFingerprint?: string;
}): WorkspaceManifest {
  if (
    input.reviewedCatalogFingerprint !== undefined
    && input.reviewedCatalogFingerprint !== input.catalog.fingerprint
  ) {
    throw reviewError([{
      field: 'catalog',
      code: 'stale-catalog',
      reason: 'The available tool catalog changed after review.',
    }]);
  }
  const validated = validateReviewedWorkspaceToolSelection(input.reviewed, input.catalog);
  if (!validated.ok) throw reviewError(validated.issues);
  const source = normalizeWorkspaceManifest(input.manifest);
  const migrated: WorkspaceManifest = {
    version: WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION,
    name: source.name,
    profile: source.profile,
    onboarded: { at: source.onboarded.at, by: source.onboarded.by },
    persona: {
      default: source.persona.default,
      enabled: [...source.persona.enabled],
    },
    orchestration: {
      mode: source.orchestration.mode,
      availableRoles: [...source.orchestration.availableRoles],
      disabledRoles: [...source.orchestration.disabledRoles],
      maxParallel: source.orchestration.maxParallel,
    },
    agents: {
      default: source.persona.default,
      enabled: [...source.persona.enabled],
    },
    capabilities: {
      enabled: [...source.capabilities.enabled],
      disabled: [...source.capabilities.disabled],
    },
    skills: {
      packs: [...source.skills.packs],
      enabled: [...source.skills.enabled],
      disabled: [...source.skills.disabled],
    },
    tools: {
      mode: 'explicit-catalog',
      profiles: validated.value.profiles,
      enabled: validated.value.enabled,
      deny: validated.value.deny,
    },
    memory: {
      tags: [...source.memory.tags],
      captureHint: source.memory.captureHint,
    },
    instructions: source.instructions,
  };
  if (source.extra) migrated.extra = source.extra;
  return normalizeWorkspaceManifest(migrated);
}

/** Content-free counts suitable for a migration badge or local diagnostic. */
export function diagnoseWorkspaceToolSelectionMigration(
  manifest: WorkspaceManifest,
  catalog: WorkspaceSelectionCatalog,
): WorkspaceToolSelectionMigrationDiagnostic {
  const groups = selectableIds(catalog, 'tool-group');
  const tools = selectableIds(catalog, 'tool');
  const selected = [
    ...manifest.tools.profiles.map((id) => groups.has(id)),
    ...(manifest.tools.enabled ?? []).map((id) => tools.has(id)),
  ];
  return {
    required: manifest.version !== WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION
      || manifest.tools.mode !== 'explicit-catalog',
    sourceVersion: manifest.version,
    unknownProfileCount: manifest.tools.profiles.filter((id) => !groups.has(id)).length,
    unknownEnabledCount: (manifest.tools.enabled ?? []).filter((id) => !tools.has(id)).length,
    blockedSelectionCount: selected.filter((available) => !available).length,
  };
}

function validateField(
  raw: readonly string[],
  field: WorkspaceSelectionReviewIssue['field'],
  kinds: readonly WorkspaceSelectionCatalogKind[],
  requireSelectable: boolean,
  catalog: WorkspaceSelectionCatalog,
  issues: WorkspaceSelectionReviewIssue[],
): string[] {
  const values = [...new Set(raw)].slice(0, 256);
  for (const id of values) {
    if (!WORKSPACE_SELECTION_STABLE_ID.test(id)) {
      issues.push({ field, id, code: 'invalid-id', reason: 'Selection IDs must use stable lowercase identifiers.' });
      continue;
    }
    const candidates = catalog.entries.filter((entry) => entry.id === id);
    if (candidates.length === 0) {
      issues.push({ field, id, code: 'unknown-entry', reason: 'Selection is not present in the current catalog.' });
      continue;
    }
    const entry = candidates.find((candidate) => kinds.includes(candidate.kind));
    if (!entry) {
      const liveOnly = candidates.find((candidate) => !candidate.persistable);
      issues.push(liveOnly
        ? { field, id, code: 'not-persistable', reason: 'Live runtime entries cannot be persisted.' }
        : { field, id, code: 'wrong-kind', reason: `Selection is not valid for ${field}.` });
      continue;
    }
    if (!entry.persistable) {
      issues.push({ field, id, code: 'not-persistable', reason: 'Live runtime entries cannot be persisted.' });
      continue;
    }
    if (requireSelectable && !entry.selectable) {
      issues.push({ field, id, code: 'blocked-entry', reason: entry.blockedReason ?? 'Selection is unavailable.' });
    }
  }
  return values.filter((id) => !issues.some((issue) => issue.field === field && issue.id === id));
}

function selectableIds(
  catalog: WorkspaceSelectionCatalog,
  kind: WorkspaceSelectionCatalogKind,
): Set<string> {
  return new Set(
    catalog.entries
      .filter((entry) => entry.kind === kind && entry.persistable && entry.selectable)
      .map((entry) => entry.id),
  );
}

function reviewError(issues: WorkspaceSelectionReviewIssue[]): Error {
  const error = new Error(`Workspace selection review failed (${issues.length} issue${issues.length === 1 ? '' : 's'}).`);
  Object.assign(error, { name: 'WorkspaceSelectionReviewError', issues });
  return error;
}
