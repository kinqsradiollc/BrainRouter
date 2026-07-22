import { redactSensitiveMemoryText } from "../util/redaction.js";

export const MEMORY_CAPTURE_MAX_TAGS = 32;
export const MEMORY_CAPTURE_MAX_TAG_CHARS = 128;
export const MEMORY_CAPTURE_TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

/** Defense-in-depth for capture paths that do not enter through the MCP schema. */
export function normalizeMemoryTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    if (normalized.length >= MEMORY_CAPTURE_MAX_TAGS) break;
    const tag = rawTag.trim().toLowerCase();
    if (
      tag.length === 0 ||
      tag.length > MEMORY_CAPTURE_MAX_TAG_CHARS ||
      !MEMORY_CAPTURE_TAG_PATTERN.test(tag) ||
      redactSensitiveMemoryText(tag) !== tag ||
      seen.has(tag)
    ) {
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

export function memoryTagsFromSensory(
  records: Array<{ memoryTags?: string[] }>,
): string[] {
  // The newest captured context replaces older workspace/profile context. Do
  // not union the window: deferred extraction may span a workspace switch.
  return normalizeMemoryTags(records.at(-1)?.memoryTags ?? []);
}
