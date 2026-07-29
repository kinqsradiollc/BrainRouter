/**
 * Trusted workspace-manifest filesystem store.
 *
 * Owns the fixed project-relative path, recovery ordering, bounded no-follow
 * reads, compatibility diagnostic recording, and guarded atomic writes.
 * Committable manifest policy remains filesystem-independent.
 */
import path from 'node:path';
import {
  recordWorkspaceCompatibilityDiagnostics,
} from '../compatibilityDiagnostics.js';
import {
  readWorkspaceFileBounded,
  writeWorkspaceFileAtomic,
} from '../fileWrite.js';
import { recoverInterruptedWorkspaceManifestClaim } from '../manifestClaim.js';
import { recoverInterruptedWorkspaceOnboardingPair } from '../onboardingTransaction.js';
import {
  WORKSPACE_MANIFEST_MAX_BYTES,
  WORKSPACE_MANIFEST_RELPATH,
  type WorkspaceManifest,
  type WorkspaceManifestLoadResult,
} from './contracts.js';
import {
  diagnoseWorkspaceManifestCompatibility,
  normalizeWorkspaceManifestRecord,
  serializeWorkspaceManifest,
} from './policy.js';

export interface SaveWorkspaceManifestOptions {
  exclusive?: boolean;
  beforeCommit?: () => void;
}

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
    recoverWorkspaceManifestStore(workspaceRoot);
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
  options: SaveWorkspaceManifestOptions = {},
): string {
  return writeWorkspaceFileAtomic(
    workspaceRoot,
    WORKSPACE_MANIFEST_RELPATH,
    serializeWorkspaceManifest(manifest),
    { exclusive: options.exclusive, beforeCommit: options.beforeCommit },
  );
}

/**
 * Restore a claimed pre-write inode before the pair coordinator classifies
 * the manifest side of an interrupted two-file onboarding commit.
 */
function recoverWorkspaceManifestStore(workspaceRoot: string): void {
  recoverInterruptedWorkspaceManifestClaim(workspaceRoot);
  recoverInterruptedWorkspaceOnboardingPair(workspaceRoot);
}
