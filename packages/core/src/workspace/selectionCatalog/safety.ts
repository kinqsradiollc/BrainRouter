import {
  WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES,
  WORKSPACE_SELECTION_STABLE_ID,
  type WorkspaceSelectionCatalogEntry,
} from './types.js';

const MAX_DESCRIPTION_BYTES = 512;

export function pushCatalogEntry(
  entries: WorkspaceSelectionCatalogEntry[],
  entry: WorkspaceSelectionCatalogEntry,
): void {
  if (entries.length >= WORKSPACE_SELECTION_CATALOG_MAX_ENTRIES || !WORKSPACE_SELECTION_STABLE_ID.test(entry.id)) return;
  entries.push({
    ...entry,
    label: safeCatalogText(entry.label, labelForId(entry.id)),
    description: safeCatalogText(entry.description, 'No description available.'),
    category: safeCatalogText(entry.category, 'other'),
    provenance: safeProvenance(entry.provenance, 'unknown'),
    runtimeAvailabilityPrerequisites: entry.runtimeAvailabilityPrerequisites
      .filter((value) => WORKSPACE_SELECTION_STABLE_ID.test(value.replace(':', '-')))
      .slice(0, 16),
    ...(entry.expandsTo ? { expandsTo: entry.expandsTo.filter(isSafeExpansionId).slice(0, 256) } : {}),
  });
}

export function safeProvenance(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value.includes('/') || value.includes('\\') || containsSensitiveOrLocalContent(value)) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return WORKSPACE_SELECTION_STABLE_ID.test(normalized) ? normalized : fallback;
}

export function safeCatalogText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text || containsSensitiveOrLocalContent(text)) return fallback;
  let bounded = text;
  while (Buffer.byteLength(bounded) > MAX_DESCRIPTION_BYTES) bounded = bounded.slice(0, -1);
  return bounded || fallback;
}

export function labelForId(id: string): string {
  return id.split(/[-_]/g).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function containsSensitiveOrLocalContent(value: string): boolean {
  return /(?:^|[\s"'=(])(?:\/(?:Users|home|private|var|tmp)\/|[A-Za-z]:\\Users\\)/.test(value)
    || /\b(?:bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9]{16,}|gh[opusr]_[A-Za-z0-9]{16,})\b/i.test(value);
}

function isSafeExpansionId(value: string): boolean {
  const id = value.startsWith('extension:')
    ? value.slice('extension:'.length)
    : value.startsWith('mcp:')
      ? value.slice('mcp:'.length)
      : value;
  return WORKSPACE_SELECTION_STABLE_ID.test(id);
}
