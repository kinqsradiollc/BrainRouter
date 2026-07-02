/**
 * Extracted from workflow.ts as part of the god-file breakdown.
 * Normalizes the many shapes an MCP `list_skills` response can take into
 * a flat `SkillListItem[]`. Exported for unit tests.
 */

import { type SkillListItem } from '../../prompt/skillCatalog.js';

export function normalizeSkillsList(payload: any): SkillListItem[] | undefined {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.skills)
      ? payload.skills
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.results)
          ? payload.results
          : undefined;
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((item: any) => item && typeof item === 'object' && typeof item.name === 'string')
    .map((item: any) => {
      const normalized: SkillListItem = { name: item.name };
      if (typeof item.scope === 'string') normalized.scope = item.scope;
      if (typeof item.category === 'string') normalized.category = item.category;
      if (typeof item.description === 'string') normalized.description = item.description;
      return normalized;
    });
}
