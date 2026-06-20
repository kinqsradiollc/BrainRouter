/**
 * TRACK (unified workspace · Track mode) — durable per-workspace project store.
 *
 * One project per workspace (the workspace root IS the project identity), with
 * its work items, sprints, and boards. Persisted at `<workspace cli state>/
 * track.json`, exactly like requirementStore / annotationStore. The record
 * shapes live in `@kinqs/brainrouter-types` (TrackProject · WorkItem · Sprint ·
 * Board) — this module never redefines them, only reads/writes/merges. Every
 * helper is a pure function of `(workspaceRoot, …)` so it is trivially testable
 * without a REPL.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type TrackProject,
  type WorkItem,
  type WorkItemType,
  type WorkItemPriority,
  type WorkItemLink,
  type WorkItemComment,
  type WorkItemActivity,
  type StatusCategory,
  type CodeLink,
  type Sprint,
  type SprintState,
  type Board,
  type BoardType,
  type BoardColumn,
  type AutomationRule,
  type AutomationTrigger,
  type AutomationAction,
  type ProjectMember,
  type ProjectRole,
  type ProjectCapability,
  roleCan,
  ROLE_RANK,
  DEFAULT_WORKFLOW_STATES,
  DEFAULT_ISSUE_TYPES,
} from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import { parseTrackQuery, matchesTrackQuery } from './query.js';

/** A recorded link from a work item to an external system's record. */
export interface ExternalLink { number: number; url: string }

interface TrackStore {
  project: TrackProject | null;
  workItems: Record<string, WorkItem>;
  sprints: Record<string, Sprint>;
  boards: Record<string, Board>;
  automations: Record<string, AutomationRule>;
  /** GitHub issue links, keyed by work-item id (external sync round-trip). */
  githubLinks: Record<string, ExternalLink>;
}

const EMPTY: TrackStore = { project: null, workItems: {}, sprints: {}, boards: {}, automations: {}, githubLinks: {} };

function trackFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'track.json');
}
function readTrack(workspaceRoot: string): TrackStore {
  return { ...EMPTY, ...readJsonFile<TrackStore>(trackFile(workspaceRoot), EMPTY) };
}
function writeTrack(workspaceRoot: string, store: TrackStore): void {
  writeJsonFile(trackFile(workspaceRoot), store);
}
function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/** A reasonable default project key from a workspace path: BrainRouter → "BR". */
function deriveKey(workspaceRoot: string): string {
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9]/g, '') || 'PROJ';
  const caps = base.replace(/[a-z]/g, '');
  const key = (caps.length >= 2 ? caps : base).slice(0, 4).toUpperCase();
  return key || 'PROJ';
}

// ── Project ───────────────────────────────────────────────────────────────────

export interface EnsureProjectInput {
  name?: string;
  key?: string;
}

/**
 * Get the workspace's project, creating it (with the default workflow + issue
 * types + a default kanban board) on first use. Idempotent — one project per
 * workspace, keyed by `workspaceRoot`.
 */
/** The local operator — the seed owner, and a trusted system actor (see SYSTEM_ACTORS). */
export const LOCAL_MEMBER_ID = 'you';

export function ensureProject(workspaceRoot: string, input: EnsureProjectInput = {}): TrackProject {
  const store = readTrack(workspaceRoot);
  if (store.project) {
    // Backfill members for projects created before A3 (permissions).
    if (!Array.isArray(store.project.members) || store.project.members.length === 0) {
      store.project.members = [{ id: LOCAL_MEMBER_ID, name: 'You', role: 'owner', addedAt: store.project.createdAt }];
      writeTrack(workspaceRoot, store);
    }
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

/** Resolve a status id to its board/report category (default `todo`). */
function categoryOf(project: TrackProject, statusId: string): StatusCategory {
  return project.workflowStates.find((s) => s.id === statusId)?.category ?? 'todo';
}

// ── Work items ────────────────────────────────────────────────────────────────

export interface CreateWorkItemInput {
  title: string;
  type?: WorkItemType;
  description?: string;
  status?: string;
  priority?: WorkItemPriority;
  assignee?: string;
  reporter?: string;
  labels?: string[];
  components?: string[];
  storyPoints?: number;
  dueDate?: string;
  parentId?: string;
  epicId?: string;
  sprintId?: string;
  sessionKey?: string;
  requirementId?: string;
  codeLinks?: CodeLink[];
  /** Who created it (a username, or `agent`/`auto`). */
  actor?: string;
}

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
  const status = input.status ?? project.workflowStates[0]?.id ?? 'todo';
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
    statusCategory: categoryOf(project, status),
    priority: input.priority ?? 'medium',
    assignee: input.assignee,
    reporter: input.reporter,
    watchers: [],
    labels: input.labels ?? [],
    components: input.components ?? [],
    storyPoints: input.storyPoints,
    dueDate: input.dueDate,
    parentId: input.parentId,
    epicId: input.epicId,
    sprintId: input.sprintId,
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

export interface WorkItemFilter {
  type?: WorkItemType;
  status?: string;
  statusCategory?: StatusCategory;
  assignee?: string;
  sprintId?: string;
  epicId?: string;
  parentId?: string;
  label?: string;
  /** Substring match over key + title (case-insensitive). */
  text?: string;
  /** A JQL-style query (see query.ts). A malformed query matches nothing. */
  query?: string;
}

/** List work items (newest first), optionally filtered. */
export function listWorkItems(workspaceRoot: string, filter: WorkItemFilter = {}): WorkItem[] {
  const items = Object.values(readTrack(workspaceRoot).workItems);
  const t = filter.text?.toLowerCase();
  const queryPred = filter.query ? parseTrackQuery(filter.query) : undefined;
  return items
    .filter((w) =>
      (filter.type === undefined || w.type === filter.type) &&
      (filter.status === undefined || w.status === filter.status) &&
      (filter.statusCategory === undefined || w.statusCategory === filter.statusCategory) &&
      (filter.assignee === undefined || w.assignee === filter.assignee) &&
      (filter.sprintId === undefined || w.sprintId === filter.sprintId) &&
      (filter.epicId === undefined || w.epicId === filter.epicId) &&
      (filter.parentId === undefined || w.parentId === filter.parentId) &&
      (filter.label === undefined || w.labels.includes(filter.label)) &&
      (t === undefined || w.key.toLowerCase().includes(t) || w.title.toLowerCase().includes(t)) &&
      (queryPred === undefined || (queryPred.ok ? queryPred.pred!(w) : false)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Fields a caller may patch. Status changes recompute the category. */
export type UpdateWorkItemPatch = Partial<
  Pick<
    WorkItem,
    | 'title' | 'description' | 'status' | 'priority' | 'assignee' | 'reporter'
    | 'labels' | 'components' | 'storyPoints' | 'estimateSeconds' | 'dueDate'
    | 'parentId' | 'epicId' | 'sprintId' | 'rank'
  >
>;

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
  const scalarFields: Array<keyof UpdateWorkItemPatch> = [
    'title', 'description', 'status', 'priority', 'assignee', 'reporter', 'storyPoints', 'estimateSeconds', 'dueDate', 'parentId', 'epicId', 'sprintId', 'rank',
  ];
  const bag = item as unknown as Record<string, unknown>;
  for (const f of scalarFields) {
    if (patch[f] !== undefined && patch[f] !== bag[f]) {
      item.activity.push({ at: ts, actor, field: String(f), from: fmt(bag[f]), to: fmt(patch[f]) });
    }
  }
  Object.assign(item, patch);
  if (patch.status !== undefined && store.project) item.statusCategory = categoryOf(store.project, patch.status);
  item.updatedAt = ts;
  store.workItems[item.id] = item;
  writeTrack(workspaceRoot, store);
  if (skipAutomation) return item;
  runAutomations(workspaceRoot, item.id, 'updated');
  return getWorkItem(workspaceRoot, item.id) ?? item;
}

function fmt(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
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

/** Add a comment; returns the updated item. */
export function addComment(workspaceRoot: string, idOrKey: string, author: string, body: string): WorkItem | undefined {
  const store = readTrack(workspaceRoot);
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return undefined;
  assertCan(workspaceRoot, author, 'edit-item');
  const ts = nowIso();
  const comment: WorkItemComment = { id: shortId('cmt'), author, body, createdAt: ts };
  item.comments.push(comment);
  item.updatedAt = ts;
  writeTrack(workspaceRoot, store);
  return item;
}

export interface LinkWorkItemInput {
  codeLinks?: CodeLink[];
  links?: WorkItemLink[];
  linkedMemoryIds?: string[];
  taskIds?: string[];
  artifactIds?: string[];
  reviewFindingIds?: string[];
  watchers?: string[];
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

// ── Sprints ───────────────────────────────────────────────────────────────────

export interface CreateSprintInput {
  name: string;
  goal?: string;
  startDate?: string;
  endDate?: string;
  capacity?: number;
}

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

export function setSprintState(workspaceRoot: string, id: string, state: SprintState): Sprint | undefined {
  const store = readTrack(workspaceRoot);
  const sprint = store.sprints[id];
  if (!sprint) return undefined;
  sprint.state = state;
  sprint.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return sprint;
}

// ── Boards ────────────────────────────────────────────────────────────────────

export interface CreateBoardInput {
  name: string;
  type?: BoardType;
  columns?: BoardColumn[];
  swimlaneField?: string;
  filter?: string;
}

export function createBoard(workspaceRoot: string, input: CreateBoardInput): Board {
  const project = ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const board: Board = {
    id: shortId('bd'), workspaceRoot, name: input.name, type: input.type ?? 'kanban',
    columns: input.columns ?? project.workflowStates.map((s) => ({ name: s.name, stateIds: [s.id] })),
    swimlaneField: input.swimlaneField, filter: input.filter, createdAt: ts, updatedAt: ts,
  };
  store.boards[board.id] = board;
  writeTrack(workspaceRoot, store);
  return board;
}

export function listBoards(workspaceRoot: string): Board[] {
  return Object.values(readTrack(workspaceRoot).boards).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Group a board's items into its columns (board view). Items are matched by
 * `status` → column `stateIds`; anything unmatched lands in an `Unmapped` bucket.
 */
export function boardView(workspaceRoot: string, boardId: string): Array<{ column: string; items: WorkItem[] }> {
  const store = readTrack(workspaceRoot);
  const board = store.boards[boardId];
  if (!board) return [];
  const items = Object.values(store.workItems);
  const cols = board.columns.map((c) => ({ column: c.name, items: items.filter((w) => c.stateIds.includes(w.status)) }));
  const mapped = new Set(board.columns.flatMap((c) => c.stateIds));
  const unmapped = items.filter((w) => !mapped.has(w.status));
  return unmapped.length ? [...cols, { column: 'Unmapped', items: unmapped }] : cols;
}

// ── Automation rules ──────────────────────────────────────────────────────────

export function listAutomations(workspaceRoot: string): AutomationRule[] {
  return Object.values(readTrack(workspaceRoot).automations).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export interface CreateAutomationInput {
  name: string;
  trigger: AutomationTrigger;
  condition?: string;
  actions: AutomationAction[];
  enabled?: boolean;
}

export function createAutomation(workspaceRoot: string, input: CreateAutomationInput): AutomationRule {
  ensureProject(workspaceRoot);
  const store = readTrack(workspaceRoot);
  const ts = nowIso();
  const rule: AutomationRule = {
    id: shortId('auto'), name: input.name, enabled: input.enabled ?? true,
    trigger: input.trigger, condition: input.condition, actions: input.actions, createdAt: ts, updatedAt: ts,
  };
  store.automations[rule.id] = rule;
  writeTrack(workspaceRoot, store);
  return rule;
}

export type AutomationPatch = Partial<Pick<AutomationRule, 'name' | 'enabled' | 'trigger' | 'condition' | 'actions'>>;

export function updateAutomation(workspaceRoot: string, id: string, patch: AutomationPatch): AutomationRule | undefined {
  const store = readTrack(workspaceRoot);
  const rule = store.automations[id];
  if (!rule) return undefined;
  Object.assign(rule, patch);
  rule.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return rule;
}

export function deleteAutomation(workspaceRoot: string, id: string): boolean {
  const store = readTrack(workspaceRoot);
  if (!store.automations[id]) return false;
  delete store.automations[id];
  writeTrack(workspaceRoot, store);
  return true;
}

/** Apply one action to an item in place; returns a short activity description, or null on no-op. */
function applyAutomationAction(project: TrackProject, item: WorkItem, action: AutomationAction): string | null {
  switch (action.type) {
    case 'set-status':
      if (!project.workflowStates.some((s) => s.id === action.value) || item.status === action.value) return null;
      item.status = action.value; item.statusCategory = categoryOf(project, action.value);
      return `status → ${action.value}`;
    case 'set-priority':
      if (item.priority === (action.value as WorkItem['priority'])) return null;
      item.priority = action.value as WorkItem['priority'];
      return `priority → ${action.value}`;
    case 'set-assignee':
      if (item.assignee === (action.value || undefined)) return null;
      item.assignee = action.value || undefined;
      return `assignee → ${action.value || 'none'}`;
    case 'add-label':
      if (item.labels.includes(action.value)) return null;
      item.labels = [...item.labels, action.value];
      return `+label ${action.value}`;
    case 'comment':
      item.comments = [...item.comments, { id: shortId('cmt'), author: 'automation', body: action.value, createdAt: nowIso() }];
      return 'commented';
    default:
      return null;
  }
}

/**
 * Run enabled rules for an item that just hit `trigger`. Actions are applied
 * DIRECTLY (not through the public mutation fns), so a rule can never re-trigger
 * automation — no loops. Persists once if anything changed.
 */
export function runAutomations(workspaceRoot: string, idOrKey: string, trigger: AutomationTrigger): void {
  const store = readTrack(workspaceRoot);
  const project = store.project;
  if (!project) return;
  const item = store.workItems[idOrKey] ?? Object.values(store.workItems).find((w) => w.key === idOrKey);
  if (!item) return;
  let changed = false;
  for (const rule of Object.values(store.automations)) {
    if (!rule.enabled || rule.trigger !== trigger) continue;
    if (rule.condition && rule.condition.trim() && !matchesTrackQuery(item, rule.condition)) continue;
    for (const action of rule.actions) {
      const desc = applyAutomationAction(project, item, action);
      if (desc) { item.activity.push({ at: nowIso(), actor: `automation:${rule.name}`, field: 'automation', to: desc }); changed = true; }
    }
  }
  if (changed) { item.updatedAt = nowIso(); writeTrack(workspaceRoot, store); }
}

// ── Members & permissions ─────────────────────────────────────────────────────

/**
 * Actors the local runtime trusts unconditionally: the human operator (`user`),
 * the AI (`agent`), and internal writers (`auto`/`automation`/`system`). Only a
 * *named project member* acting as themselves is role-checked — this keeps the
 * single-user app fully functional while making roles real for any caller that
 * passes a member id as the actor (federation, shared boards, scripted members).
 */
const SYSTEM_ACTORS = new Set(['user', 'agent', 'auto', 'automation', 'system']);

/** Thrown when an actor lacks the capability for an operation. */
export class PermissionError extends Error {
  constructor(public actor: string, public capability: ProjectCapability) {
    super(`"${actor}" is not permitted to ${capability.replace(/-/g, ' ')} on this project`);
    this.name = 'PermissionError';
  }
}

export function listMembers(workspaceRoot: string): ProjectMember[] {
  const project = getProject(workspaceRoot);
  return project?.members ? [...project.members].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]) : [];
}

/** Resolve an actor's effective role, or `undefined` if they aren't a tracked member. */
export function memberRole(workspaceRoot: string, actor: string): ProjectRole | undefined {
  return getProject(workspaceRoot)?.members?.find((m) => m.id === actor)?.role;
}

/**
 * May `actor` perform `capability`? System actors and non-members are trusted
 * (local single-user default); tracked members are checked against their role.
 */
export function canActor(workspaceRoot: string, actor: string, capability: ProjectCapability): boolean {
  if (SYSTEM_ACTORS.has(actor)) return true;
  const role = memberRole(workspaceRoot, actor);
  if (!role) return true; // not a tracked member → local trust
  return roleCan(role, capability);
}

function assertCan(workspaceRoot: string, actor: string, capability: ProjectCapability): void {
  if (!canActor(workspaceRoot, actor, capability)) throw new PermissionError(actor, capability);
}

export interface AddMemberInput {
  id: string;
  name?: string;
  role?: ProjectRole;
}

/** Add a member (or update their role/name if already present). Requires `manage-members`. */
export function addMember(workspaceRoot: string, input: AddMemberInput, actor = 'user'): ProjectMember {
  ensureProject(workspaceRoot);
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project!;
  const id = input.id.trim();
  if (!id) throw new Error('Member id is required.');
  const role = input.role ?? 'member';
  const existing = project.members.find((m) => m.id === id);
  if (existing) {
    if (existing.role === 'owner' && role !== 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
      throw new Error('Cannot demote the last owner.');
    }
    existing.role = role;
    if (input.name !== undefined) existing.name = input.name;
  } else {
    project.members.push({ id, name: input.name, role, addedAt: nowIso() });
  }
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return project.members.find((m) => m.id === id)!;
}

/** Change a member's role. Requires `manage-members`; refuses to remove the last owner. */
export function updateMemberRole(workspaceRoot: string, id: string, role: ProjectRole, actor = 'user'): ProjectMember | undefined {
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project;
  const member = project?.members.find((m) => m.id === id);
  if (!project || !member) return undefined;
  if (member.role === 'owner' && role !== 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
    throw new Error('Cannot demote the last owner.');
  }
  member.role = role;
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return member;
}

/** Remove a member. Requires `manage-members`; refuses to remove the last owner. */
export function removeMember(workspaceRoot: string, id: string, actor = 'user'): boolean {
  assertCan(workspaceRoot, actor, 'manage-members');
  const store = readTrack(workspaceRoot);
  const project = store.project;
  const member = project?.members.find((m) => m.id === id);
  if (!project || !member) return false;
  if (member.role === 'owner' && project.members.filter((m) => m.role === 'owner').length === 1) {
    throw new Error('Cannot remove the last owner.');
  }
  project.members = project.members.filter((m) => m.id !== id);
  project.updatedAt = nowIso();
  writeTrack(workspaceRoot, store);
  return true;
}

// ── External sync links (GitHub issues) ───────────────────────────────────────

/** The recorded external links, keyed by work-item id. Used by the GitHub sync. */
export function getGithubLinks(workspaceRoot: string): Record<string, ExternalLink> {
  return readTrack(workspaceRoot).githubLinks ?? {};
}

/** Record (or clear, with `null`) the GitHub issue a work item maps to. */
export function setGithubLink(workspaceRoot: string, workItemId: string, link: ExternalLink | null): void {
  const store = readTrack(workspaceRoot);
  if (!store.githubLinks) store.githubLinks = {};
  if (link) store.githubLinks[workItemId] = link;
  else delete store.githubLinks[workItemId];
  writeTrack(workspaceRoot, store);
}
