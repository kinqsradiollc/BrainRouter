/**
 * Workspace profile-default manifest construction.
 *
 * A25-5d2: resolves a profile preset plus reviewed overrides into a normalized
 * committable manifest without touching filesystem trust or onboarding state.
 */
import {
  getWorkspaceProfile,
  type WorkspaceProfileId,
} from '../../profiles.js';
import { resolveWorkspaceProfileOrchestrationDefaults } from '../../profileOrchestrationDefaults.js';
import {
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceManifest,
  type WorkspaceOnboardSource,
} from '../contracts.js';
import { normalizeWorkspaceManifestRecord } from './normalization.js';
import { isBoundedString } from './sensitiveValues.js';

export function createWorkspaceManifest(input: {
  name: string;
  profile: WorkspaceProfileId;
  by: WorkspaceOnboardSource;
  at?: string;
  overrides?: Partial<Pick<
    WorkspaceManifest,
    | 'planning'
    | 'persona'
    | 'orchestration'
    | 'agents'
    | 'capabilities'
    | 'skills'
    | 'tools'
    | 'memory'
    | 'instructions'
  >>;
}): WorkspaceManifest {
  const preset = getWorkspaceProfile(input.profile) ??
    getWorkspaceProfile('custom')!;
  const orchestrationDefaults =
    resolveWorkspaceProfileOrchestrationDefaults(preset.id);
  const overrides = input.overrides ?? {};
  const persona = overrides.persona ?? overrides.agents ?? {
    default: preset.persona.default,
    enabled: [...preset.persona.enabled],
  };
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_MANIFEST_VERSION,
    name: isBoundedString(input.name)
      ? input.name.trim() || 'workspace'
      : 'workspace',
    profile: preset.id,
    ...(overrides.planning ? { planning: overrides.planning } : {}),
    onboarded: { at: input.at ?? new Date().toISOString(), by: input.by },
    persona,
    orchestration: overrides.orchestration ?? {
      mode: orchestrationDefaults.mode,
      availableRoles: orchestrationDefaults.availableRoles,
      disabledRoles: orchestrationDefaults.disabledRoles,
      maxParallel: orchestrationDefaults.maxParallel,
    },
    agents: persona,
    capabilities: overrides.capabilities ?? {
      enabled: [...preset.capabilities.recommended],
      disabled: [],
    },
    skills: overrides.skills ?? {
      packs: [...preset.skills.packs],
      enabled: [...preset.skills.enabled],
      disabled: [],
    },
    tools: overrides.tools ?? {
      profiles: [...preset.tools.profiles],
      deny: [],
    },
    memory: overrides.memory ?? {
      tags: [...preset.memory.tags],
      captureHint: preset.memory.captureHint,
    },
    instructions: overrides.instructions ?? 'AGENT.md',
  };
  return normalizeWorkspaceManifestRecord(
    manifest as unknown as Record<string, unknown>,
  );
}
