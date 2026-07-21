/**
 * Workspace onboarding bridge (ADR-021 W3a) — the main-process half of the
 * desktop add-workspace onboarding. The renderer never touches the manifest
 * file: it reads state and submits choices over IPC, and MAIN goes through
 * the core chokepoint (`@kinqs/brainrouter-core/workspace`) exclusively, so
 * desktop and CLI onboarding produce byte-identical manifests.
 *
 * Kept separate from main.ts so the payload validation is unit-testable
 * without an Electron runtime.
 */
import path from 'node:path';
import {
  WORKSPACE_PROFILES,
  createWorkspaceManifest,
  isWorkspaceProfileId,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  suggestWorkspaceProfile,
  type ProfileSuggestion,
  type WorkspaceManifest,
  type WorkspaceProfilePreset,
} from '@kinqs/brainrouter-core/workspace';

export interface WorkspaceManifestInfo {
  onboarded: boolean;
  manifest: WorkspaceManifest | null;
  suggestion: ProfileSuggestion;
  /** The full preset catalog so the renderer renders cards from data. */
  profiles: readonly WorkspaceProfilePreset[];
}

/** Everything the onboarding modal needs to render, in one round-trip. */
export function getWorkspaceManifestInfo(workspaceRoot: string): WorkspaceManifestInfo {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  return {
    onboarded: manifest !== null,
    manifest,
    suggestion: suggestWorkspaceProfile(workspaceRoot),
    profiles: WORKSPACE_PROFILES,
  };
}

export interface ManifestSavePayload {
  profile: unknown;
}

export type ManifestSaveResult =
  | { saved: true; manifest: WorkspaceManifest }
  | { saved: false; error: string };

/**
 * Validate the renderer's onboarding submission and write the manifest.
 * Unknown profiles are REJECTED (never coerced) — the renderer shows the error
 * instead of silently onboarding wrong. An already-onboarded workspace is also
 * rejected: edits go through the future settings editor, not the add-workspace
 * modal. Profile presets own their agent/capability defaults; the renderer
 * cannot substitute a second engineering persona.
 */
export function saveWorkspaceManifestFromPayload(workspaceRoot: string, payload: ManifestSavePayload): ManifestSaveResult {
  const profile = typeof payload.profile === 'string' ? payload.profile : '';
  if (!isWorkspaceProfileId(profile)) return { saved: false, error: `Unknown profile: ${String(payload.profile)}` };
  if (loadWorkspaceManifest(workspaceRoot) !== null) return { saved: false, error: 'Workspace is already onboarded.' };

  const manifest = createWorkspaceManifest({
    name: path.basename(workspaceRoot),
    profile,
    by: 'wizard',
  });
  saveWorkspaceManifest(workspaceRoot, manifest);
  return { saved: true, manifest };
}
