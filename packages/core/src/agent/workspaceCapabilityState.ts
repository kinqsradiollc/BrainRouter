/**
 * W4a per-turn workspace capability state for the agent runtime.
 *
 * This is the only bridge between the committable workspace manifest and the
 * model-visible capability prompt. It deliberately grants no tools or skills;
 * later policy layers consume the stored resolution through their own gates.
 * Missing or unreadable manifests retract any stale tagged prompt and otherwise
 * leave the conversation unchanged.
 */
import { loadWorkspaceManifest } from '../workspace/manifest.js';
import {
  resolveWorkspaceCapabilities,
  workspaceCapabilityIds,
  type WorkspaceCapabilityResolution,
} from '../workspace/capabilities.js';
import {
  findDomainPersona,
  renderDomainPersonaBriefing,
} from '../workspace/domainPersonas.js';
import { getWorkspaceProfile } from '../workspace/profiles.js';
import { workspaceToolProfileIds } from '../workspace/toolProfiles.js';

export interface WorkspaceCapabilityStateHost {
  workspaceRoot: string;
  workspaceAgentId?: string;
  activeWorkspacePersonaId?: string;
  activeWorkspaceCapabilities: WorkspaceCapabilityResolution;
  replaceTaggedSystemMessage(tag: string, content: string): void;
  removeTaggedSystemMessage(tag: string): void;
}

const WORKSPACE_CAPABILITY_TAG = 'workspace-capabilities';
const WORKSPACE_PERSONA_TAG = 'workspace-domain-persona';

/** Resolve and publish the additive prompt overlay for one task. */
export function refreshWorkspaceCapabilityState(
  host: WorkspaceCapabilityStateHost,
  task: string,
): WorkspaceCapabilityResolution {
  const manifest = loadWorkspaceManifest(host.workspaceRoot);
  const requestedPersona = manifest && host.workspaceAgentId && manifest.persona.enabled.includes(host.workspaceAgentId)
    ? findDomainPersona(host.workspaceAgentId, host.workspaceRoot)
    : undefined;
  const defaultPersona = manifest && manifest.persona.enabled.includes(manifest.persona.default)
    ? findDomainPersona(manifest.persona.default, host.workspaceRoot)
    : undefined;
  const activePersona = requestedPersona ?? defaultPersona;
  const activeAgent = activePersona?.id;
  host.activeWorkspacePersonaId = activeAgent;

  const resolution = resolveWorkspaceCapabilities({
    manifest,
    activeAgent,
    task,
    availability: { toolProfiles: workspaceToolProfileIds() },
  });
  host.activeWorkspaceCapabilities = resolution;

  if (manifest) {
    const preset = getWorkspaceProfile(manifest.profile);
    const disabled = new Set(manifest.capabilities.disabled);
    const knownCapabilities = new Set(workspaceCapabilityIds());
    const availableCapabilities = manifest.capabilities.enabled.filter(
      (id) => knownCapabilities.has(id) && !disabled.has(id),
    );
    host.replaceTaggedSystemMessage(
      WORKSPACE_PERSONA_TAG,
      [
        '## Workspace profile briefing',
        `Profile: ${preset?.label ?? manifest.profile} (${manifest.profile})`,
        `Available task capabilities: ${formatIds(availableCapabilities)}`,
        `Active task capabilities: ${formatIds(resolution.active)}`,
        ...(activePersona ? ['', renderDomainPersonaBriefing(activePersona)] : []),
      ].join('\n'),
    );
  } else {
    host.removeTaggedSystemMessage(WORKSPACE_PERSONA_TAG);
  }

  if (resolution.promptBlocks.length === 0) {
    host.removeTaggedSystemMessage(WORKSPACE_CAPABILITY_TAG);
    return resolution;
  }

  host.replaceTaggedSystemMessage(
    WORKSPACE_CAPABILITY_TAG,
    ['## Active workspace capabilities', ...resolution.promptBlocks].join('\n\n'),
  );
  return resolution;
}

function formatIds(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(', ') : 'none';
}
