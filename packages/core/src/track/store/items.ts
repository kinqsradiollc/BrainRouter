/**
 * TRACK store — work items.
 *
 * The heart of the board: creating, querying, patching, transitioning, linking,
 * commenting, archiving, and deleting work items. Status changes recompute the
 * lifecycle category and `completedAt`; every mutation goes through the
 * permission guard and (unless suppressed) fires the automation engine.
 */
import type { WorkItem, WorkItemComment, CodeLink } from '@kinqs/brainrouter-types';
import {
  readTrack,
  writeTrack,
  shortId,
  nowIso,
  fmt,
  categoryOf,
  defaultStatusId,
  registerLabel,
  normalizeAssignees,
} from './_internal.js';
import { ensureProject, getProject } from './project.js';
import { assertCan } from './members.js';
import { runAutomations } from './automations.js';
import { parseTrackQuery } from '../query/query.js';
import type {
  CreateWorkItemInput,
  WorkItemFilter,
  UpdateWorkItemPatch,
  CommentExternal,
  LinkWorkItemInput,
} from './types.js';

/**
 * Create a work item. Mints a `<projectKey>-<n>` key (bumping the project
 * counter), resolves the status category, stamps id/timestamps, seeds a
 * `created` activity entry, and persists. Auto-creates the project on first use.
 */
export function createWorkItem(workspaceRoot: string, input: CreateWorkItemInput): WorkItem {
  ensureProject(workspaceRoot);
  assertCan(workspaceRoot, input.actor ?? 'user', 'create-item');
  const store = readTrack(workspaceRoot);
  const project = store.project!;
  const status = input.status ?? defaultStatusId(project);
  const category = categoryOf(project, status);
  const assignees = normalizeAssignees(input.assignees ?? (input.assignee ? [input.assignee] : []));
  const labels = input.labels ?? [];
  for (const name of labels) registerLabel(project, name);
  const n = project.keyCounter;
  project.keyCounter = n + 1;
  project.updatedAt = nowIso();
  const ts = nowIso();
  const item: WorkItem = {
    id: shortId('wi'),
    key: `${project.key}-${n}`,
    type: input.type ?? 'task',
    title: input.title,
    description: input.description,
    status,
    statusCategory: category,
    priority: input.priority ?? 'none',
    assignees,
    assignee: assignees[0],
    reporter: input.reporter,
    watchers: [],
    labels,
    components: input.components ?? [],
    storyPoints: input.storyPoints,
    startDate: input.startDate,
    targetDate: input.targetDate,
    completedAt: category === 'completed' ? ts : undefined,
    parentId: input.parentId,
    epicId: input.epicId,
    sprintId: input.sprintId,
    moduleId: input.moduleId,
    links: [],
    comments: [],
    attachmentIds: [],
    activity: [{ at: ts, actor: input.actor ?? 'user', field: 'created' }],
    workspaceRoot,
    sessionKey: input.sessionKey,
    linkedMemoryIds: [],
    codeLinks: input.codeLinks ?? [],
    requirementId: input.requirementId,
    taskIds: [],
    artifactIds: [],
    reviewFindingIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  store.workItems[item.id] = item;
  writeTrack(workspaceRoot, store);
  runAutomations(workspaceRoot, item.id, 'created');
  return getWorkItem(workspaceRoot, item.id) ?? item;
}

export function getWorkItem(workspaceRoot: string, idOrKey: string): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  return store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
}

/** List work items (newest first), optionally filtered. Archived items are excluded unless asked for. */
export function listWorkItems(workspaceRoot: string, filter: WorkItemFilter = {}): WorkItem[] {
  const items = Object.values(readTrack(workspaceRoot).workItems);
  const t = filter.text?.toLowerCase();
  const queryPred = filter.query ? parseTrackQuery(filter.query) : undefined;
  return items
    .filter((w) =>
      (filter.includeArchived || !w.archivedAt) &&
      (filter.type === undefined || w.type === filter.type) &&
      (filter.status === undefined || w.status === filter.status) &&
      (filter.statusCategory === undefined || w.statusCategory === filter.statusCategory) &&
      (filter.assignee === undefined || w.assignees.includes(filter.assignee)) &&
      (filter.sprintId === undefined || w.sprintId === filter.sprintId) &&
      (filter.moduleId === undefined || w.moduleId === filter.moduleId) &&
      (filter.epicId === undefined || w.epicId === filter.epicId) &&
      (filter.parentId === undefined || w.parentId === filter.parentId) &&
      (filter.label === undefined || w.labels.includes(filter.label)) &&
      (t === undefined || w.key.toLowerCase().includes(t) || w.title.toLowerCase().includes(t)) &&
      (queryPred === undefined || (queryPred.ok ? queryPred.pred!(w) : false)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Return every work item carrying this exact persisted code-link reference. */
export function findWorkItemsByCodeLink(
  workspaceRoot: string,
  link: Pick<CodeLink, 'kind' | 'ref'>,
): WorkItem[] {
  const ref = link.ref?.trim();
  if (!ref) return [];
  return listWorkItems(workspaceRoot).filter((item) =>
    item.codeLinks.some((candidate) => candidate.kind === link.kind && candidate.ref.trim() === ref),
  );
}

/**
 * Apply a patch, appending an activity entry per changed scalar field and
 * recomputing `statusCategory` when `status` changes. Returns the updated item
 * (or `undefined` if it doesn't exist).
 */
export function updateWorkItem(
  workspaceRoot: string,
  idOrKey: string,
  patch: UpdateWorkItemPatch,
  actor = 'user',
  skipAutomation = false,
): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return undefined;
  assertCan(workspaceRoot, actor, 'edit-item');
  const ts = nowIso();
  // Resolve a multi-assignee change from either field (assignees wins; legacy
  // `assignee` is folded in). `assignee` then mirrors `assignees[0]`.
  let nextAssignees: string[] | undefined;
  if (patch.assignees !== undefined) nextAssignees = normalizeAssignees(patch.assignees);
  else if (patch.assignee !== undefined) nextAssignees = patch.assignee ? normalizeAssignees([patch.assignee]) : [];
  const scalarFields: Array<keyof UpdateWorkItemPatch> = [
    'title', 'description', 'status', 'priority', 'reporter', 'storyPoints', 'estimateSeconds', 'startDate', 'targetDate', 'parentId', 'epicId', 'sprintId', 'moduleId', 'rank',
  ];
  const bag = item as unknown as Record<string, unknown>;
  for (const f of scalarFields) {
    if (patch[f] !== undefined && patch[f] !== bag[f]) {
      item.activity.push({ at: ts, actor, field: String(f), from: fmt(bag[f]), to: fmt(patch[f]) });
    }
  }
  if (nextAssignees !== undefined && nextAssignees.join(',') !== item.assignees.join(',')) {
    item.activity.push({ at: ts, actor, field: 'assignees', from: item.assignees.join(', ') || undefined, to: nextAssignees.join(', ') || undefined });
  }
  if (patch.labels !== undefined && store.project) {
    for (const name of patch.labels) registerLabel(store.project, name);
  }
  Object.assign(item, patch);
  if (nextAssignees !== undefined) { item.assignees = nextAssignees; item.assignee = nextAssignees[0]; }
  if (patch.status !== undefined && store.project) {
    item.statusCategory = categoryOf(store.project, patch.status);
    // Auto-manage completedAt as the item enters/leaves a completed state.
    if (item.statusCategory === 'completed') { if (!item.completedAt) item.completedAt = ts; }
    else item.completedAt = undefined;
  }
  item.updatedAt = ts;
  store.workItems[item.id] = item;
  writeTrack(workspaceRoot, store);
  if (skipAutomation) return item;
  runAutomations(workspaceRoot, item.id, 'updated');
  return getWorkItem(workspaceRoot, item.id) ?? item;
}

/** Transition a work item to a new status (validates against the workflow). */
export function transitionWorkItem(workspaceRoot: string, idOrKey: string, toStatus: string, actor = 'user'): WorkItem | undefined {
  const project = getProject(workspaceRoot);
  if (project && !project.workflowStates.some((s) => s.id === toStatus)) {
    throw new Error(`Unknown workflow state "${toStatus}". Valid: ${project.workflowStates.map((s) => s.id).join(', ')}`);
  }
  const item = updateWorkItem(workspaceRoot, idOrKey, { status: toStatus }, actor, true); // skip the 'updated' trigger
  if (!item) return undefined;
  runAutomations(workspaceRoot, item.id, 'transitioned');
  return getWorkItem(workspaceRoot, item.id) ?? item;
}

/** Add a comment; returns the updated item. `external` tags it as synced (round-trip key). */
export function addComment(workspaceRoot: string, idOrKey: string, author: string, body: string, external?: CommentExternal): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return undefined;
  assertCan(workspaceRoot, author, 'edit-item');
  const ts = nowIso();
  const comment: WorkItemComment = { id: shortId('cmt'), author, body, createdAt: ts, ...external };
  item.comments.push(comment);
  item.updatedAt = ts;
  writeTrack(workspaceRoot, store);
  return item;
}

/** Record the external id for a locally-authored comment after it is pushed to GitHub. */
export function recordCommentSync(workspaceRoot: string, itemId: string, commentId: string, external: CommentExternal): void {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[itemId];
  const comment = item?.comments.find((c) => c.id === commentId);
  if (!comment) return;
  comment.externalSource = external.externalSource;
  comment.externalId = external.externalId;
  writeTrack(workspaceRoot, store);
}

/** Merge-append provenance/relationship links onto a work item (deduped). */
export function linkWorkItem(workspaceRoot: string, idOrKey: string, input: LinkWorkItemInput): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return undefined;
  const uniq = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
  if (input.linkedMemoryIds) item.linkedMemoryIds = uniq(item.linkedMemoryIds, input.linkedMemoryIds);
  if (input.taskIds) item.taskIds = uniq(item.taskIds, input.taskIds);
  if (input.artifactIds) item.artifactIds = uniq(item.artifactIds, input.artifactIds);
  if (input.reviewFindingIds) item.reviewFindingIds = uniq(item.reviewFindingIds, input.reviewFindingIds);
  if (input.watchers) item.watchers = uniq(item.watchers, input.watchers);
  if (input.codeLinks) {
    const seen = new Set(item.codeLinks.map((c) => `${c.kind}:${c.ref}`));
    for (const c of input.codeLinks) {
      const k = `${c.kind}:${c.ref}`;
      if (!seen.has(k)) { item.codeLinks.push(c); seen.add(k); }
    }
  }
  if (input.links) {
    const seen = new Set(item.links.map((l) => `${l.type}:${l.targetId}`));
    for (const l of input.links) {
      const k = `${l.type}:${l.targetId}`;
      if (!seen.has(k)) { item.links.push(l); seen.add(k); }
    }
  }
  item.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return item;
}

/** Delete a work item; returns true if one was removed. */
export function deleteWorkItem(workspaceRoot: string, idOrKey: string): boolean {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return false;
  delete store.workItems[item.id];
  writeTrack(workspaceRoot, store);
  return true;
}

/**
 * Archive (or, with `archived=false`, restore) a work item. Archived items keep
 * all their data but drop out of the default board/list views — the soft-delete
 * counterpart to {@link deleteWorkItem}. Returns the updated item.
 */
export function setWorkItemArchived(workspaceRoot: string, idOrKey: string, archived = true, actor = 'user'): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return undefined;
  assertCan(workspaceRoot, actor, 'edit-item');
  const next = archived ? nowIso() : undefined;
  if ((item.archivedAt ?? undefined) === next) return item;
  const ts = nowIso();
  item.activity.push({ at: ts, actor, field: 'archived', from: fmt(item.archivedAt), to: archived ? 'true' : 'false' });
  item.archivedAt = next;
  item.updatedAt = ts;
  writeTrack(workspaceRoot, store);
  return item;
}
