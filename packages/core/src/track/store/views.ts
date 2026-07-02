/**
 * TRACK store — saved views.
 *
 * Named filter + layout presets (a query, grouping, ordering, and a layout kind)
 * the UI restores by name. Upsert-by-name so re-saving a view updates it in place.
 */
import type { SavedView } from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, shortId, nowIso } from './_internal.js';
import { ensureProject } from './project.js';
import type { SaveViewInput } from './types.js';

/** Create or update (by case-insensitive name) a saved view — a filter + layout preset. */
export function saveView(workspaceRoot: string, input: SaveViewInput): SavedView {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const name = input.name.trim();
  if (!name) throw new Error('View name is required.');
  const ts = nowIso();
  const existing = Object.values(store.views).find((v) => v.name.toLowerCase() === name.toLowerCase());
  const view: SavedView = {
    id: existing?.id ?? shortId('view'),
    workspaceRoot,
    name,
    layout: input.layout,
    query: input.query?.trim() || undefined,
    filters: input.filters && Object.keys(input.filters).length ? input.filters : undefined,
    groupBy: input.groupBy,
    orderBy: input.orderBy,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  store.views[view.id] = view;
  writeTrack(workspaceRoot, store);
  return view;
}

/** List saved views (alphabetical by name). */
export function listViews(workspaceRoot: string): SavedView[] {
  return Object.values(readTrack(workspaceRoot).views).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a saved view by id or (case-insensitive) name. */
export function getView(workspaceRoot: string, idOrName: string): SavedView | undefined {
  const store = readTrack(workspaceRoot);
  const key = idOrName.trim().toLowerCase();
  return store.views[idOrName] ?? Object.values(store.views).find((v) => v.name.toLowerCase() === key);
}

/** Delete a saved view by id or name. */
export function deleteView(workspaceRoot: string, idOrName: string): boolean {
  const store = readTrack(workspaceRoot);
  const key = idOrName.trim().toLowerCase();
  const view = store.views[idOrName] ?? Object.values(store.views).find((v) => v.name.toLowerCase() === key);
  if (!view) return false;
  delete store.views[view.id];
  writeTrack(workspaceRoot, store);
  return true;
}
