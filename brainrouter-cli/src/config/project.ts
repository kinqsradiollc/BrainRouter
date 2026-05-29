/**
 * AUG-A1 (0.4.1) — Project (multi-folder) scope marker.
 *
 * A `.brainrouter/project.json` file at the workspace root names a
 * logical Project that can span several workspaces:
 *
 *   { "name": "acme-platform" }
 *
 * The name hashes to a stable `projectTag` (via `projectTagFromName`),
 * which the brain stores on records and recall can scope to with
 * `scope: 'project'`. No marker → no active project (recall stays
 * workspace-scoped, the default).
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectTagFromName } from '@kinqs/brainrouter-types';

export interface ProjectMarker {
  name: string;
}

/** Read `.brainrouter/project.json` for the workspace; null when absent/invalid. */
export function readProjectMarker(workspaceRoot: string): ProjectMarker | null {
  try {
    const file = path.join(workspaceRoot, '.brainrouter', 'project.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    return name ? { name } : null;
  } catch {
    return null;
  }
}

/** Active project name for the workspace, or null. */
export function activeProjectName(workspaceRoot: string): string | null {
  return readProjectMarker(workspaceRoot)?.name ?? null;
}

/** Canonical project tag for the workspace's active project, or null. */
export function activeProjectTag(workspaceRoot: string): string | null {
  return projectTagFromName(activeProjectName(workspaceRoot));
}
