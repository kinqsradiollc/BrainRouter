/**
 * TRACK store — shared internals.
 *
 * The low-level foundation every `track/store/*` module builds on: the on-disk
 * {@link TrackStore} shape, its schema migration, the read/write/persist
 * helpers, and the small pure helpers (`categoryOf`, `registerLabel`, …) that
 * several feature modules need. Deliberately imports NOTHING from its sibling
 * store modules, so the store graph stays a strict DAG (foundation → features).
 *
 * The durable record shapes (TrackProject · WorkItem · Sprint · Board) live in
 * `@kinqs/brainrouter-types` — this layer only reads/writes/merges them.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type TrackProject,
  type WorkItem,
  type WorkItemPriority,
  type StatusCategory,
  type WorkflowState,
  type Sprint,
  type Module,
  type SavedView,
  type Board,
  type AutomationRule,
  type TrackLabel,
  STATUS_CATEGORY_COLORS,
  colorForLabelName,
} from '@kinqs/brainrouter-types';
import { getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import type { ExternalLink, GithubSyncTarget } from './types.js';

export interface TrackStore {
  project: TrackProject | null;
  workItems: Record<string, WorkItem>;
  sprints: Record<string, Sprint>;
  modules: Record<string, Module>;
  views: Record<string, SavedView>;
  boards: Record<string, Board>;
  automations: Record<string, AutomationRule>;
  /** GitHub issue links, keyed by work-item id (external sync round-trip). */
  githubLinks: Record<string, ExternalLink>;
  /**
   * Connector-first sync target (connector Phase 0). When set, Track sync
   * resolves its repo + credential through THIS connector — the legacy global
   * `cli.track.github*` knobs are only a fallback for workspaces that haven't
   * migrated. Per-workspace on purpose: connectors are workspace-scoped, so a
   * global pointer would dangle in every other workspace.
   */
  githubSyncTarget?: GithubSyncTarget;
  /** One-time marker for the legacy cli.track.github* → connector migration. */
  githubMigratedAt?: string;
  /** Migration marker; bumped whenever the record shapes change (see migrateStore). */
  schemaVersion?: number;
}

export const EMPTY: TrackStore = { project: null, workItems: {}, sprints: {}, modules: {}, views: {}, boards: {}, automations: {}, githubLinks: {} };

/**
 * Current on-disk schema.
 * v2 = lifecycle groups + urgent/none priority + start/target/completed/archived dates.
 * v3 = multi-assignee (`assignees`) + the project label registry.
 */
const SCHEMA_VERSION = 3;

/** Remap pre-v2 lifecycle groups (3-lane todo/in-progress/done) onto the new groups. */
const CATEGORY_MIGRATION: Record<string, StatusCategory> = {
  todo: 'unstarted',
  'in-progress': 'started',
  done: 'completed',
};
/** Remap pre-v2 priorities (lowest…highest) onto the new urgent…none scale. */
const PRIORITY_MIGRATION: Record<string, WorkItemPriority> = {
  lowest: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  highest: 'urgent',
};

/** The local operator — the seed owner, and a trusted system actor (see SYSTEM_ACTORS). */
export const LOCAL_MEMBER_ID = 'you';

/**
 * Idempotently bring an on-disk store up to {@link SCHEMA_VERSION}. Remaps the
 * pre-v2 status categories + priorities, backfills state colors and a default
 * flag, moves `dueDate`→`targetDate`, recomputes each item's `statusCategory`
 * from its (remapped) state, and backfills `completedAt`. Returns whether any
 * change was made so the caller persists exactly once.
 */
function migrateStore(store: TrackStore): boolean {
  if ((store.schemaVersion ?? 1) >= SCHEMA_VERSION) return false;
  let changed = false;
  if (store.project) {
    for (const s of store.project.workflowStates as WorkflowState[]) {
      const remapped = CATEGORY_MIGRATION[s.category as string];
      if (remapped && s.category !== remapped) { s.category = remapped; changed = true; }
      if (!s.color) { s.color = STATUS_CATEGORY_COLORS[s.category] ?? '#94a3b8'; changed = true; }
    }
    if (!store.project.workflowStates.some((s) => s.default) && store.project.workflowStates[0]) {
      store.project.workflowStates[0].default = true; changed = true;
    }
    // v3: a label registry, backfilled from the labels already in use.
    if (!Array.isArray(store.project.labels)) { store.project.labels = []; changed = true; }
    for (const item of Object.values(store.workItems)) {
      const bag = item as unknown as Record<string, unknown>;
      const remapped = PRIORITY_MIGRATION[item.priority as string];
      if (remapped && remapped !== item.priority) { item.priority = remapped; changed = true; }
      if (typeof bag.dueDate === 'string' && !bag.targetDate) { bag.targetDate = bag.dueDate; changed = true; }
      if ('dueDate' in bag) { delete bag.dueDate; changed = true; }
      const cat = categoryOf(store.project, item.status);
      if (item.statusCategory !== cat) { item.statusCategory = cat; changed = true; }
      if (cat === 'completed' && !item.completedAt) { item.completedAt = item.updatedAt; changed = true; }
      // v3: derive the assignees list from the legacy single `assignee`.
      if (!Array.isArray(item.assignees)) {
        item.assignees = item.assignee ? [item.assignee] : []; changed = true;
      }
      if (item.assignee !== item.assignees[0]) { item.assignee = item.assignees[0]; changed = true; }
      for (const name of item.labels ?? []) registerLabel(store.project, name);
    }
  }
  store.schemaVersion = SCHEMA_VERSION;
  return changed || !!store.project || Object.keys(store.workItems).length > 0;
}

function trackFile(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, 'track.json');
}
export function readTrack(workspaceRoot: string): TrackStore {
  const store = { ...EMPTY, ...readJsonFile<TrackStore>(trackFile(workspaceRoot), EMPTY) };
  if (migrateStore(store)) writeJsonFile(trackFile(workspaceRoot), store);
  return store;
}
export function writeTrack(workspaceRoot: string, store: TrackStore): void {
  store.schemaVersion = SCHEMA_VERSION;
  writeJsonFile(trackFile(workspaceRoot), store);
}
export function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
export function nowIso(): string {
  return new Date().toISOString();
}

/** A reasonable default project key from a workspace path: BrainRouter → "BR". */
export function deriveKey(workspaceRoot: string): string {
  const base = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9]/g, '') || 'PROJ';
  const caps = base.replace(/[a-z]/g, '');
  const key = (caps.length >= 2 ? caps : base).slice(0, 4).toUpperCase();
  return key || 'PROJ';
}

/** Resolve a status id to its lifecycle group (default `backlog`). */
export function categoryOf(project: TrackProject, statusId: string): StatusCategory {
  return project.workflowStates.find((s) => s.id === statusId)?.category ?? 'backlog';
}

/** The status id new items default into: the project's `default` state, else the first. */
export function defaultStatusId(project: TrackProject): string {
  return project.workflowStates.find((s) => s.default)?.id ?? project.workflowStates[0]?.id ?? 'backlog';
}

/** Register a label name in the project registry if absent (auto-colored). Returns the label. */
export function registerLabel(project: TrackProject, name: string): TrackLabel {
  const trimmed = name.trim();
  const existing = project.labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const label: TrackLabel = { id: shortId('lbl'), name: trimmed, color: colorForLabelName(trimmed) };
  project.labels.push(label);
  return label;
}

/** Trim, drop empties, de-dupe an assignee list (order preserved). */
export function normalizeAssignees(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of list) { const v = a.trim(); if (v && !out.includes(v)) out.push(v); }
  return out;
}

export function fmt(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}
