/**
 * TRACK — external sync (GitHub Issues): pure mapping + 3-way-merge primitives.
 *
 * Everything here is a pure function of its arguments (no network, no store) and
 * unit-tested directly: work-item ↔ issue field mapping, the round-trip key
 * marker, and the snapshot/merge helpers the bidirectional sync builds on.
 */
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, StatusCategory } from '@kinqs/brainrouter-types';
import { isWorkItemType, isWorkItemPriority, isTerminalCategory } from '@kinqs/brainrouter-types';
import type { UpdateWorkItemPatch, GithubMirrorSnapshot } from '../trackStore.js';
import type { GithubIssue, GithubIssuePayload, MappedIssue } from './types.js';

// ── Pure mapping ──────────────────────────────────────────────────────────────

const MARKER_RE = /<!--\s*brainrouter:([A-Za-z0-9]+-\d+)\s*-->/;

/** The hidden marker appended to an exported issue body so imports round-trip. */
export function keyMarker(key: string): string {
  return `<!-- brainrouter:${key} -->`;
}

/** Extract a work-item key from an issue body marker, if present. */
export function keyFromBody(body: string | null | undefined): string | undefined {
  const m = (body ?? '').match(MARKER_RE);
  return m ? m[1] : undefined;
}

const labelNames = (labels: GithubIssue['labels']): string[] =>
  (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean);

/** Extract {name, color} pairs from issue labels (GitHub hex `color` has no `#`). */
export const labelColors = (labels: GithubIssue['labels']): Array<{ name: string; color?: string }> =>
  (labels ?? [])
    .map((l) => (typeof l === 'string' ? { name: l } : { name: l?.name ?? '', color: l?.color ? `#${l.color}` : undefined }))
    .filter((l) => l.name && !l.name.startsWith('type:') && !l.name.startsWith('priority:'));

/** A work item → the issue payload we POST/PATCH. Status category drives open/closed. */
export function workItemToIssue(item: WorkItem, includeMarker = true): GithubIssuePayload {
  const labels = [
    `type:${item.type}`,
    `priority:${item.priority}`,
    ...item.labels.filter((l) => !l.startsWith('type:') && !l.startsWith('priority:')),
  ];
  const desc = item.description ? `${item.description}\n\n` : '';
  const body = includeMarker ? `${desc}${keyMarker(item.key)}` : desc.trimEnd();
  // Assignees are treated as GitHub logins (members are pulled from the repo).
  return { title: item.title, body, labels, assignees: item.assignees, state: isTerminalCategory(item.statusCategory) ? 'closed' : 'open' };
}

/** Every GitHub login assigned to an issue (legacy `assignee` + the `assignees` array, deduped). */
function issueAssignees(issue: GithubIssue): string[] {
  const out: string[] = [];
  for (const login of [issue.assignee?.login, ...(issue.assignees ?? []).map((a) => a?.login)]) {
    if (login && !out.includes(login)) out.push(login);
  }
  return out;
}

/** Resolve a concrete project status id for a target category (first match). */
function statusForCategory(project: TrackProject, category: StatusCategory): string {
  return project.workflowStates.find((s) => s.category === category)?.id ?? project.workflowStates[0]?.id ?? 'backlog';
}

/** A GitHub issue → the fields we create/update a work item with. */
export function issueToWorkItem(issue: GithubIssue, project: TrackProject): MappedIssue {
  const names = labelNames(issue.labels);
  const typeLabel = names.find((n) => n.startsWith('type:'))?.slice('type:'.length);
  const priLabel = names.find((n) => n.startsWith('priority:'))?.slice('priority:'.length);
  const type: WorkItemType = isWorkItemType(typeLabel) ? typeLabel : 'task';
  const priority: WorkItemPriority = isWorkItemPriority(priLabel) ? priLabel : 'none';
  const plainLabels = names.filter((n) => !n.startsWith('type:') && !n.startsWith('priority:'));
  const status = statusForCategory(project, issue.state === 'closed' ? 'completed' : 'unstarted');
  const body = (issue.body ?? '').replace(MARKER_RE, '').trim();
  const assignees = issueAssignees(issue);
  return {
    key: keyFromBody(issue.body),
    input: { title: issue.title, type, priority, status, description: body || undefined, labels: plainLabels, assignees },
    patch: { title: issue.title, priority, status, description: body || undefined, labels: plainLabels, assignees },
  };
}

// ── Bidirectional sync (3-way merge) ─────────────────────────────────────────

// `type` is create-only (updateWorkItem can't change it), so it is snapshotted
// for the record but NOT reconciled — the rest are the GitHub-mirrored fields.
const MERGE_FIELDS = ['title', 'description', 'priority', 'closed', 'labels', 'assignees'] as const;
type MergeField = typeof MERGE_FIELDS[number];

const sortedSet = (a: string[]): string[] => [...new Set(a)].sort();
const sameSet = (a: string[], b: string[]): boolean => {
  const sa = sortedSet(a), sb = sortedSet(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};
const plainLabels = (labels: string[]): string[] =>
  sortedSet(labels.filter((l) => !l.startsWith('type:') && !l.startsWith('priority:')));

function eqField(f: MergeField, a: GithubMirrorSnapshot, b: GithubMirrorSnapshot): boolean {
  return f === 'labels' || f === 'assignees' ? sameSet(a[f], b[f]) : a[f] === b[f];
}

/** The local work item as a GitHub-mirror snapshot. */
export function snapshotFromItem(item: WorkItem): GithubMirrorSnapshot {
  return {
    title: item.title,
    description: item.description ?? '',
    type: item.type,
    priority: item.priority,
    labels: plainLabels(item.labels),
    assignees: sortedSet(item.assignees),
    closed: isTerminalCategory(item.statusCategory),
  };
}

/** A GitHub issue as a mirror snapshot. */
export function snapshotFromIssue(issue: GithubIssue): GithubMirrorSnapshot {
  const names = labelNames(issue.labels);
  const typeLabel = names.find((n) => n.startsWith('type:'))?.slice('type:'.length);
  const priLabel = names.find((n) => n.startsWith('priority:'))?.slice('priority:'.length);
  return {
    title: issue.title,
    description: (issue.body ?? '').replace(MARKER_RE, '').trim(),
    type: isWorkItemType(typeLabel) ? typeLabel : 'task',
    priority: isWorkItemPriority(priLabel) ? priLabel : 'none',
    labels: plainLabels(names),
    assignees: sortedSet(issueAssignees(issue)),
    closed: issue.state === 'closed',
  };
}

export interface MergeOutcome {
  /** Remote-only field changes to write to the LOCAL item. */
  pull: Partial<GithubMirrorSnapshot>;
  /** True when a field changed only locally → the GitHub issue must be updated. */
  push: boolean;
  conflicts: MergeField[];
  /** The reconciled snapshot to persist as the next baseline (conflict fields kept at base). */
  merged: GithubMirrorSnapshot;
}

/**
 * 3-way merge one linked pair. Base is the last-synced snapshot; with no base
 * (first reconcile of a pre-existing link) REMOTE is treated as base, so a local
 * value that differs from remote counts as a local edit (pushed up) — biasing
 * to never silently lose local work.
 */
export function mergePair(base: GithubMirrorSnapshot | undefined, local: GithubMirrorSnapshot, remote: GithubMirrorSnapshot): MergeOutcome {
  const b = base ?? remote;
  const pull: Partial<GithubMirrorSnapshot> = {};
  const conflicts: MergeField[] = [];
  // Index-write through plain records — a union-keyed property can't be written
  // to directly (its write type narrows to `never`).
  const merged = { ...local } as unknown as Record<string, unknown>;
  const bRec = b as unknown as Record<string, unknown>;
  const remoteRec = remote as unknown as Record<string, unknown>;
  const pullRec = pull as unknown as Record<string, unknown>;
  let push = false;
  for (const f of MERGE_FIELDS) {
    const localChanged = !eqField(f, local, b);
    const remoteChanged = !eqField(f, remote, b);
    if (localChanged && remoteChanged && !eqField(f, local, remote)) {
      conflicts.push(f);
      merged[f] = bRec[f];
    } else if (remoteChanged) {
      pullRec[f] = remoteRec[f];
      merged[f] = remoteRec[f];
    } else if (localChanged) {
      push = true;
    }
  }
  return { pull, push, conflicts, merged: merged as unknown as GithubMirrorSnapshot };
}

export function snapshotToPatch(p: Partial<GithubMirrorSnapshot>, project: TrackProject): UpdateWorkItemPatch & { labels?: string[] } {
  const patch: UpdateWorkItemPatch & { labels?: string[] } = {};
  if (p.title !== undefined) patch.title = p.title;
  if (p.description !== undefined) patch.description = p.description || undefined;
  if (p.priority !== undefined && isWorkItemPriority(p.priority)) patch.priority = p.priority;
  if (p.labels !== undefined) patch.labels = p.labels;
  if (p.assignees !== undefined) patch.assignees = p.assignees;
  if (p.closed !== undefined) patch.status = statusForCategory(project, p.closed ? 'completed' : 'unstarted');
  return patch;
}

export function snapshotToIssuePayload(snap: GithubMirrorSnapshot, key: string): GithubIssuePayload {
  return {
    title: snap.title,
    body: `${snap.description ? `${snap.description}\n\n` : ''}${keyMarker(key)}`,
    labels: [`type:${snap.type}`, `priority:${snap.priority}`, ...snap.labels],
    assignees: snap.assignees,
    state: snap.closed ? 'closed' : 'open',
  };
}
