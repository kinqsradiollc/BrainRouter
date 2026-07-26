import path from 'node:path';
import {
  buildWorkspaceOnboardingPreview,
  createWorkspaceManifest,
  migrateWorkspaceManifestToolSelection,
  normalizeWorkspaceManifest,
  validateReviewedWorkspaceCapabilitySelection,
  validateReviewedWorkspaceRoleSelection,
  validateReviewedWorkspaceSkillSelection,
  type WorkspaceSelectionCatalog,
  type WorkspaceManifest,
  type WorkspaceOnboardSource,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';

export interface ProjectOnboardingFieldEdits {
  personaDefault: string;
  personasEnabled: string[];
  orchestrationMode: 'off' | 'explicit' | 'adaptive';
  orchestrationAvailableRoles: string[];
  orchestrationDisabledRoles: string[];
  orchestrationMaxParallel: number;
  capabilitiesEnabled: string[];
  capabilitiesDisabled: string[];
  skillPacks: string[];
  skillsEnabled: string[];
  skillsDisabled: string[];
  toolProfiles: string[];
  toolsEnabled: string[];
  toolsDenied: string[];
  memoryTags: string[];
  memoryCaptureHint: string;
  instructions: string;
}

/** Trim, de-duplicate, and preserve order for comma-separated editor fields. */
export function parseProjectOnboardingList(input: string): string[] {
  return [...new Set(input.split(',').map((part) => part.trim()).filter(Boolean))];
}

/**
 * Create the mutable draft shown by the CLI review flow. Same-profile edits
 * retain every normalized field; changing profile starts from that preset but
 * preserves durable identity, instruction pointer, and safe forward fields.
 */
export function createProjectOnboardingDraft(input: {
  workspaceRoot: string;
  profile: WorkspaceProfileId;
  existing?: WorkspaceManifest | null;
  source?: WorkspaceOnboardSource;
  now?: () => string;
}): WorkspaceManifest {
  const existing = input.existing ? normalizeWorkspaceManifest(input.existing) : null;
  if (existing?.profile === input.profile) return normalizeWorkspaceManifest(existing);

  const draft = createWorkspaceManifest({
    name: existing?.name ?? (path.basename(path.resolve(input.workspaceRoot)) || 'workspace'),
    profile: input.profile,
    by: input.source ?? 'wizard',
    at: existing?.onboarded.at ?? input.now?.(),
  });
  if (!existing) return draft;
  return normalizeWorkspaceManifest({
    ...draft,
    onboarded: { ...existing.onboarded },
    instructions: existing.instructions,
    ...(existing.extra ? { extra: existing.extra } : {}),
  });
}

/** Apply every reviewed editor field as one normalized draft transition. */
export function applyProjectOnboardingEdits(
  draft: WorkspaceManifest,
  edits: ProjectOnboardingFieldEdits,
): WorkspaceManifest {
  const personaDefault = edits.personaDefault.trim();
  const personasEnabled = unique(edits.personasEnabled);
  if (personaDefault && !personasEnabled.includes(personaDefault)) personasEnabled.unshift(personaDefault);
  const disabledRoles = unique(edits.orchestrationDisabledRoles);
  const disabledRoleSet = new Set(disabledRoles);
  return normalizeWorkspaceManifest({
    ...draft,
    persona: { default: personaDefault, enabled: personasEnabled },
    // Keep the serialized v1 compatibility alias synchronized while readers migrate.
    agents: { default: personaDefault, enabled: personasEnabled },
    orchestration: {
      mode: edits.orchestrationMode,
      availableRoles: unique(edits.orchestrationAvailableRoles)
        .filter((role) => !disabledRoleSet.has(role)),
      disabledRoles,
      maxParallel: edits.orchestrationMaxParallel,
    },
    capabilities: {
      enabled: unique(edits.capabilitiesEnabled),
      disabled: unique(edits.capabilitiesDisabled),
    },
    skills: {
      packs: unique(edits.skillPacks),
      enabled: unique(edits.skillsEnabled),
      disabled: unique(edits.skillsDisabled),
    },
    tools: {
      profiles: unique(edits.toolProfiles),
      enabled: unique(edits.toolsEnabled),
      deny: unique(edits.toolsDenied),
    },
    memory: { tags: unique(edits.memoryTags), captureHint: edits.memoryCaptureHint.trim() },
    instructions: edits.instructions.trim(),
  });
}

/**
 * Validate the exact reviewed catalog choices and move the saved tool contract
 * to explicit-catalog mode. This is the final in-memory step before commit.
 */
export function finalizeCatalogReviewedProjectOnboarding(
  draft: WorkspaceManifest,
  edits: ProjectOnboardingFieldEdits,
  catalog: WorkspaceSelectionCatalog,
): WorkspaceManifest {
  const edited = applyProjectOnboardingEdits(draft, edits);
  const roles = validateReviewedWorkspaceRoleSelection({
    availableRoles: edited.orchestration.availableRoles,
    disabledRoles: edited.orchestration.disabledRoles,
  }, catalog);
  if (!roles.ok) {
    throw new Error(formatCatalogReviewIssues('role', roles.issues));
  }
  const capabilityCatalog = {
    ...catalog,
    entries: buildWorkspaceOnboardingPreview(edited, catalog).catalog,
  };
  const capabilities = validateReviewedWorkspaceCapabilitySelection(
    edited.capabilities,
    capabilityCatalog,
  );
  if (!capabilities.ok) {
    throw new Error(formatCatalogReviewIssues('capability', capabilities.issues));
  }
  const skills = validateReviewedWorkspaceSkillSelection({
    packs: edited.skills.packs,
    enabled: edited.skills.enabled,
    disabled: edited.skills.disabled,
  }, catalog);
  if (!skills.ok) {
    throw new Error(formatCatalogReviewIssues('skill', skills.issues));
  }
  return migrateWorkspaceManifestToolSelection({
    manifest: {
      ...edited,
      orchestration: {
        ...edited.orchestration,
        availableRoles: roles.value.availableRoles,
        disabledRoles: roles.value.disabledRoles,
      },
      capabilities: capabilities.value,
      skills: skills.value,
    },
    reviewed: {
      profiles: edited.tools.profiles,
      enabled: unique(edits.toolsEnabled),
      deny: edited.tools.deny,
    },
    catalog,
    reviewedCatalogFingerprint: catalog.fingerprint,
  });
}

function formatCatalogReviewIssues(
  kind: 'role' | 'capability' | 'skill' | 'tool',
  issues: ReadonlyArray<{ field: string; id?: string; reason: string }>,
): string {
  const detail = issues
    .slice(0, 8)
    .map((issue) => `${issue.field}${issue.id ? `:${issue.id}` : ''} (${issue.reason})`)
    .join('; ');
  return `Reviewed ${kind} selection is no longer available${detail ? `: ${detail}` : '.'}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
