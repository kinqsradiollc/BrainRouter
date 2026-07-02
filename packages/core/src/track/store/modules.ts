/**
 * TRACK store — modules (project components / feature areas).
 *
 * A coarser grouping than sprints: long-lived areas of work items roll up to.
 * Owns module CRUD, soft-archive, and deletion that clears the reference off
 * every work item.
 */
import type { Module } from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, shortId, nowIso } from './_internal.js';
import { ensureProject } from './project.js';
import type { CreateModuleInput, UpdateModulePatch } from './types.js';

export function createModule(workspaceRoot: string, input: CreateModuleInput): Module {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const module: Module = {
    id: shortId('mod'), workspaceRoot, name: input.name, description: input.description,
    status: input.status ?? 'planned', lead: input.lead, members: input.members ?? [],
    startDate: input.startDate, targetDate: input.targetDate, createdAt: ts, updatedAt: ts,
  };
  store.modules[module.id] = module;
  writeTrack(workspaceRoot, store);
  return module;
}

/** List modules (newest first). Archived modules are excluded unless asked for. */
export function listModules(workspaceRoot: string, opts: { includeArchived?: boolean } = {}): Module[] {
  return Object.values(readTrack(workspaceRoot).modules)
    .filter((m) => opts.includeArchived || !m.archivedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Resolve a module by id or (case-insensitive) name. */
export function getModule(workspaceRoot: string, idOrName: string): Module | undefined {
  const store = readTrack(workspaceRoot);
  const key = idOrName.trim().toLowerCase();
  return store.modules[idOrName] ?? Object.values(store.modules).find((m) => m.name.toLowerCase() === key);
}

export function updateModule(workspaceRoot: string, id: string, patch: UpdateModulePatch): Module | undefined {
  const store = readTrack(workspaceRoot);
  const module = store.modules[id] ?? Object.values(store.modules).find((m) => m.name.toLowerCase() === id.trim().toLowerCase());
  if (!module) return undefined;
  Object.assign(module, patch);
  module.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return module;
}

/** Archive (or restore) a module — hides it from the default list; items keep their `moduleId`. */
export function setModuleArchived(workspaceRoot: string, id: string, archived = true): Module | undefined {
  const store = readTrack(workspaceRoot);
  const module = store.modules[id];
  if (!module) return undefined;
  module.archivedAt = archived ? nowIso() : undefined;
  module.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return module;
}

/** Delete a module and clear it from every work item that referenced it. */
export function deleteModule(workspaceRoot: string, id: string): boolean {
  const store = readTrack(workspaceRoot);
  const module = store.modules[id] ?? Object.values(store.modules).find((m) => m.name.toLowerCase() === id.trim().toLowerCase());
  if (!module) return false;
  delete store.modules[module.id];
  for (const item of Object.values(store.workItems)) {
    if (item.moduleId === module.id) { item.moduleId = undefined; item.updatedAt = nowIso(); }
  }
  writeTrack(workspaceRoot, store);
  return true;
}
