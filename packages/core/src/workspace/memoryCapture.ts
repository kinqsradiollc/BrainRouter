import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspaceManifest } from './manifest.js';

export const WORKSPACE_MEMORY_CAPTURE_MAX_TAGS = 32;
export const WORKSPACE_MEMORY_CAPTURE_MAX_TAG_CHARS = 128;

const WORKSPACE_MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface WorkspaceMemoryCaptureContext {
  memoryTags: string[];
}

/**
 * Resolve the committable manifest's semantic memory tags for one capture.
 * A missing/unreadable manifest returns null so callers can preserve the exact
 * legacy MCP payload. Invalid hand-edited values fail closed at this boundary.
 */
export function resolveWorkspaceMemoryCaptureContext(
  workspaceRoot: string,
): WorkspaceMemoryCaptureContext | null {
  const manifest = loadWorkspaceManifest(workspaceRoot);
  if (!manifest) return null;

  const memoryTags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of manifest.memory.tags) {
    if (memoryTags.length >= WORKSPACE_MEMORY_CAPTURE_MAX_TAGS) break;
    const tag = rawTag.trim().toLowerCase();
    if (
      tag.length === 0 ||
      tag.length > WORKSPACE_MEMORY_CAPTURE_MAX_TAG_CHARS ||
      !WORKSPACE_MEMORY_TAG_PATTERN.test(tag) ||
      seen.has(tag)
    ) {
      continue;
    }
    seen.add(tag);
    memoryTags.push(tag);
  }

  return { memoryTags };
}

/**
 * ADR-017 D3 — the active Project name for a workspace, from its
 * `.brainrouter/project.json` marker (`{ "name": "acme-platform" }`); null when
 * absent/invalid. The brain hashes this to a stable `project_tag` so recall can
 * scope to a logical Project that spans several workspaces. Kept independent of
 * the workspace manifest: a project marker can exist with no manifest, and must
 * still tag captures.
 */
export function resolveWorkspaceProjectName(workspaceRoot: string): string | null {
  if (!workspaceRoot) return null;
  try {
    const file = path.join(workspaceRoot, '.brainrouter', 'project.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
