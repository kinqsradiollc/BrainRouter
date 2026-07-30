/**
 * Workspace-manifest contracts and fixed normalization limits.
 *
 * A25-5d1: keeps the committable profile-selection vocabulary independent of
 * profile policy, compatibility translation, filesystem trust, and onboarding
 * transaction composition. The existing manifest facade remains unchanged.
 */
import path from 'node:path';
import type { WorkspacePlanningSelection } from '@kinqs/brainrouter-types/planning-schema';
import type { WorkspaceCompatibilityDiagnostic } from '../compatibilityDiagnostics.js';
import type { WorkspaceProfileId } from '../profiles.js';

export const WORKSPACE_MANIFEST_VERSION = 2;
export const WORKSPACE_MANIFEST_EXPLICIT_TOOL_SELECTION_VERSION = 3;
export const WORKSPACE_MANIFEST_RELPATH = path.join(
  '.brainrouter',
  'workspace.json',
);
export const WORKSPACE_MANIFEST_MAX_BYTES = 256 * 1024;
export const WORKSPACE_MANIFEST_MAX_STRING_BYTES = 4 * 1024;
export const WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES = 256;
export const WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH = 8;
export const WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES = 4 * 1024;

export type WorkspaceOnboardSource = 'wizard' | 'agent' | 'import';
export type WorkspaceOrchestrationMode = 'off' | 'explicit' | 'adaptive';
export type WorkspaceToolSelectionMode =
  | 'legacy-groups'
  | 'explicit-catalog';

export interface WorkspaceManifest {
  version: number;
  name: string;
  profile: WorkspaceProfileId;
  /** Omitted for profile defaults; present only after an explicit reviewed selection. */
  planning?: WorkspacePlanningSelection;
  onboarded: { at: string; by: WorkspaceOnboardSource };
  persona: { default: string; enabled: string[] };
  orchestration: {
    mode: WorkspaceOrchestrationMode;
    availableRoles: string[];
    disabledRoles: string[];
    maxParallel: number;
  };
  /** @deprecated Serialized manifest-v1/client compatibility alias for `persona`. */
  agents: { default: string; enabled: string[] };
  capabilities: { enabled: string[]; disabled: string[] };
  skills: { packs: string[]; enabled: string[]; disabled: string[] };
  tools: {
    /** Present on v3 manifests. V2 is interpreted as `legacy-groups` without rewriting it. */
    mode?: WorkspaceToolSelectionMode;
    profiles: string[];
    /** Present on v3 manifests; stable local catalog IDs only. */
    enabled?: string[];
    deny: string[];
  };
  memory: { tags: string[]; captureHint: string };
  /** Instruction-file pointer (e.g. "AGENT.md") — a reference, never content. */
  instructions: string;
  /** Safe unknown fields from newer writers, preserved on round-trip. */
  extra?: Record<string, unknown>;
}

export interface WorkspaceManifestLoadResult {
  manifest: WorkspaceManifest | null;
  diagnostics: WorkspaceCompatibilityDiagnostic[];
}
