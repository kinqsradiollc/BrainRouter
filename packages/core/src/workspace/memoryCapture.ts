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
