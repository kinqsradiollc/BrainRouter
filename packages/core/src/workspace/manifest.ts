/**
 * Workspace-manifest compatibility facade and trusted filesystem composition.
 *
 * Preserves the established `workspace/manifest` public entrypoint while
 * delegating committable contracts and pure profile policy to focused owners.
 * Trusted load/save and transaction-recovery composition remain here until
 * their dependency-ordered extraction.
 */
import path from 'node:path';
import { readWorkspaceFileBounded, writeWorkspaceFileAtomic } from './fileWrite.js';
import { recoverInterruptedWorkspaceManifestClaim } from './manifestClaim.js';
import { recoverInterruptedWorkspaceOnboardingPair } from './onboardingTransaction.js';
import {
  recordWorkspaceCompatibilityDiagnostics,
} from './compatibilityDiagnostics.js';
import {
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_RELPATH,
  type WorkspaceManifest,
  type WorkspaceManifestLoadResult,
} from './manifest/contracts.js';
import {
  diagnoseWorkspaceManifestCompatibility,
  normalizeWorkspaceManifestRecord,
  serializeWorkspaceManifest,
} from './manifest/policy.js';

export * from './manifest/contracts.js';
export {
  createWorkspaceManifest,
  diagnoseWorkspaceManifestCompatibility,
  normalizeWorkspaceManifest,
  serializeWorkspaceManifest,
} from './manifest/policy.js';
export {
  WORKSPACE_PROFILES,
  getWorkspaceProfile,
  isWorkspaceProfileId,
} from './profiles.js';
export type {
  WorkspaceProfileId,
  WorkspaceProfilePreset,
} from './profiles.js';

export function workspaceManifestPath(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_MANIFEST_RELPATH);
}

export function isWorkspaceOnboarded(workspaceRoot: string): boolean {
  return loadWorkspaceManifest(workspaceRoot) !== null;
}

export function loadWorkspaceManifest(
  workspaceRoot: string,
): WorkspaceManifest | null {
  return loadWorkspaceManifestWithDiagnostics(workspaceRoot).manifest;
}

export function loadWorkspaceManifestWithDiagnostics(
  workspaceRoot: string,
): WorkspaceManifestLoadResult {
  let raw: unknown;
  try {
    recoverInterruptedWorkspaceManifestClaim(workspaceRoot);
    recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
    raw = JSON.parse(
      readWorkspaceFileBounded(
        workspaceRoot,
        WORKSPACE_MANIFEST_RELPATH,
        WORKSPACE_MANIFEST_MAX_BYTES,
      ).toString('utf8'),
    );
  } catch {
    return { manifest: null, diagnostics: [] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { manifest: null, diagnostics: [] };
  }
  const record = raw as Record<string, unknown>;
  const diagnostics = diagnoseWorkspaceManifestCompatibility(record);
  recordWorkspaceCompatibilityDiagnostics(workspaceRoot, diagnostics);
  return {
    manifest: normalizeWorkspaceManifestRecord(record),
    diagnostics,
  };
}

export function saveWorkspaceManifest(
  workspaceRoot: string,
  manifest: WorkspaceManifest,
  options: {
    exclusive?: boolean;
    beforeCommit?: () => void;
  } = {},
): string {
  const serialized = serializeWorkspaceManifest(manifest);
  return writeWorkspaceFileAtomic(
    workspaceRoot,
    WORKSPACE_MANIFEST_RELPATH,
    serialized,
    { exclusive: options.exclusive, beforeCommit: options.beforeCommit },
  );
}
