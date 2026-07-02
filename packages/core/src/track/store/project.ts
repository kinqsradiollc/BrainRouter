/**
 * TRACK store — the project record.
 *
 * One project per workspace (the workspace root IS the project identity). Owns
 * project creation/lookup; the work items, sprints, boards, and so on that hang
 * off it live in the sibling store modules.
 */
import {
  type TrackProject,
  type Board,
  DEFAULT_WORKFLOW_STATES,
  DEFAULT_ISSUE_TYPES,
} from '@kinqs/brainrouter-types';
import path from 'node:path';
import {
  readTrack,
  writeTrack,
  shortId,
  nowIso,
  deriveKey,
  registerLabel,
  LOCAL_MEMBER_ID,
} from './_internal.js';
import type { EnsureProjectInput } from './types.js';

/**
 * Get the workspace's project, creating it (with the default workflow + issue
 * types + a default kanban board) on first use. Idempotent — one project per
 * workspace, keyed by `workspaceRoot`.
 */
export function ensureProject(workspaceRoot: string, input: EnsureProjectInput = {}): TrackProject {
  const store = readTrack(workspaceRoot);
  if (store.project) {
    let dirty = false;
    // Backfill members for projects created before A3 (permissions).
    if (!Array.isArray(store.project.members) || store.project.members.length === 0) {
      store.project.members = [{ id: LOCAL_MEMBER_ID, name: 'You', role: 'owner', addedAt: store.project.createdAt }];
      dirty = true;
    }
    // Backfill the label registry (pre-T2 projects) from the labels in use.
    if (!Array.isArray(store.project.labels)) {
      store.project.labels = [];
      const names = new Set(Object.values(store.workItems).flatMap((w) => w.labels ?? []));
      for (const name of names) registerLabel(store.project, name);
      dirty = true;
    }
    if (dirty) writeTrack(workspaceRoot, store);
    return store.project;
  }
  const ts = nowIso();
  const project: TrackProject = {
    id: shortId('proj'),
    workspaceRoot,
    name: input.name ?? (path.basename(workspaceRoot) || 'Project'),
    key: (input.key ?? deriveKey(workspaceRoot)).toUpperCase(),
    keyCounter: 1,
    workflowStates: [...DEFAULT_WORKFLOW_STATES],
    issueTypes: [...DEFAULT_ISSUE_TYPES],
    components: [],
    labels: [],
    members: [{ id: LOCAL_MEMBER_ID, name: 'You', role: 'owner', addedAt: ts }],
    createdAt: ts,
    updatedAt: ts,
  };
  store.project = project;
  // A default kanban board: one column per workflow state.
  const board: Board = {
    id: shortId('bd'),
    workspaceRoot,
    name: 'Board',
    type: 'kanban',
    columns: project.workflowStates.map((s) => ({ name: s.name, stateIds: [s.id] })),
    createdAt: ts,
    updatedAt: ts,
  };
  store.boards[board.id] = board;
  writeTrack(workspaceRoot, store);
  return project;
}

export function getProject(workspaceRoot: string): TrackProject | undefined {
  return readTrack(workspaceRoot).project ?? undefined;
}
