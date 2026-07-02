/**
 * TRACK store — sprints.
 *
 * Time-boxed iterations items can be assigned to. Owns sprint CRUD, the
 * single-active-sprint invariant, and the completed-story-point velocity roll-up.
 */
import type { Sprint, SprintState } from '@kinqs/brainrouter-types';
import { readTrack, writeTrack, shortId, nowIso } from './_internal.js';
import { ensureProject } from './project.js';
import type { CreateSprintInput, UpdateSprintPatch } from './types.js';

export function createSprint(workspaceRoot: string, input: CreateSprintInput): Sprint {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const sprint: Sprint = {
    id: shortId('sp'), workspaceRoot, name: input.name, goal: input.goal,
    state: 'future', startDate: input.startDate, endDate: input.endDate, capacity: input.capacity,
    createdAt: ts, updatedAt: ts,
  };
  store.sprints[sprint.id] = sprint;
  writeTrack(workspaceRoot, store);
  return sprint;
}

export function listSprints(workspaceRoot: string): Sprint[] {
  return Object.values(readTrack(workspaceRoot).sprints).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Update mutable sprint fields without changing its lifecycle state. */
export function updateSprint(workspaceRoot: string, id: string, patch: UpdateSprintPatch): Sprint | undefined {
  const store = readTrack(workspaceRoot);
  const sprint = store.sprints[id];
  if (!sprint) return undefined;
  Object.assign(sprint, patch);
  sprint.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return sprint;
}

/** Sum completed story points for a sprint. Items without estimates contribute zero. */
export function sprintVelocity(workspaceRoot: string, sprintId: string): number | undefined {
  const store = readTrack(workspaceRoot);
  if (!store.sprints[sprintId]) return undefined;
  return Object.values(store.workItems)
    .filter((item) => item.sprintId === sprintId && item.statusCategory === 'completed')
    .reduce((total, item) => total + (item.storyPoints ?? 0), 0);
}

export function setSprintState(workspaceRoot: string, id: string, state: SprintState): Sprint | undefined {
  const store = readTrack(workspaceRoot);
  const sprint = store.sprints[id];
  if (!sprint) return undefined;
  if (state === 'active') {
    const active = Object.values(store.sprints).find((candidate) => candidate.id !== id && candidate.state === 'active');
    if (active) throw new Error(`Sprint "${active.name}" is already active.`);
  }
  sprint.state = state;
  sprint.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return sprint;
}
