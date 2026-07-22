import path from 'node:path';
import {
  createWorkspaceManifest,
  normalizeWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceOnboardSource,
  type WorkspaceProfileId,
} from '@kinqs/brainrouter-core/workspace';

export interface ProjectOnboardingFieldEdits {
  agentDefault: string;
  agentsEnabled: string[];
  capabilitiesEnabled: string[];
  capabilitiesDisabled: string[];
  skillPacks: string[];
  skillsEnabled: string[];
  skillsDisabled: string[];
  toolProfiles: string[];
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
    version: existing.version,
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
  const agentDefault = edits.agentDefault.trim();
  const agentsEnabled = unique(edits.agentsEnabled);
  if (agentDefault && !agentsEnabled.includes(agentDefault)) agentsEnabled.unshift(agentDefault);
  return normalizeWorkspaceManifest({
    ...draft,
    agents: { default: agentDefault, enabled: agentsEnabled },
    capabilities: {
      enabled: unique(edits.capabilitiesEnabled),
      disabled: unique(edits.capabilitiesDisabled),
    },
    skills: {
      packs: unique(edits.skillPacks),
      enabled: unique(edits.skillsEnabled),
      disabled: unique(edits.skillsDisabled),
    },
    tools: { profiles: unique(edits.toolProfiles), deny: unique(edits.toolsDenied) },
    memory: { tags: unique(edits.memoryTags), captureHint: edits.memoryCaptureHint.trim() },
    instructions: edits.instructions.trim(),
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
