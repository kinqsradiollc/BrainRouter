/**
 * TRACK store — the project label registry.
 *
 * Labels are named + colored tags shared across work items; the registry is the
 * source of truth for their colors (round-tripped with GitHub). Registration
 * happens lazily wherever a label name first appears (see `registerLabel`); this
 * module is the explicit CRUD surface over that registry.
 */
import type { TrackLabel } from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, nowIso, registerLabel } from './_internal.js';
import { ensureProject, getProject } from './project.js';
import type { UpsertLabelInput } from './types.js';

/** List the project's labels (alphabetical). */
export function listLabels(workspaceRoot: string): TrackLabel[] {
  const project = getProject(workspaceRoot);
  return project?.labels ? [...project.labels].sort((a, b) => a.name.localeCompare(b.name)) : [];
}

/** Create or update (by case-insensitive name) a label in the registry. */
export function upsertLabel(workspaceRoot: string, input: UpsertLabelInput): TrackLabel {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const project = store.project!;
  const name = input.name.trim();
  if (!name) throw new Error('Label name is required.');
  const label = registerLabel(project, name);
  if (input.color) label.color = input.color;
  if (input.description !== undefined) label.description = input.description;
  if (input.externalSource !== undefined) label.externalSource = input.externalSource;
  if (input.externalId !== undefined) label.externalId = input.externalId;
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return label;
}

/** Resolve a label by id or (case-insensitive) name. */
export function getLabel(workspaceRoot: string, idOrName: string): TrackLabel | undefined {
  const project = getProject(workspaceRoot);
  const key = idOrName.trim().toLowerCase();
  return project?.labels.find((l) => l.id === idOrName || l.name.toLowerCase() === key);
}

/**
 * Delete a label from the registry and strip its name from every work item.
 * Returns true if a label was removed.
 */
export function deleteLabel(workspaceRoot: string, idOrName: string): boolean {
  const store = readTrack(workspaceRoot);
  const project = store.project;
  if (!project) return false;
  const key = idOrName.trim().toLowerCase();
  const label = project.labels.find((l) => l.id === idOrName || l.name.toLowerCase() === key);
  if (!label) return false;
  project.labels = project.labels.filter((l) => l.id !== label.id);
  for (const item of Object.values(store.workItems)) {
    if (item.labels.some((n) => n.toLowerCase() === label.name.toLowerCase())) {
      item.labels = item.labels.filter((n) => n.toLowerCase() !== label.name.toLowerCase());
      item.updatedAt = nowIso();
    }
  }
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return true;
}
