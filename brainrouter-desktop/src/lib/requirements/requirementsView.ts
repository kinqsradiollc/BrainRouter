/**
 * REQUIREMENT-RECORDS — pure presentation helpers for the Requirements panel.
 * The CLI owns the store (createRequirement/updateRequirement/listRequirements,
 * all tested there); this just shapes a RequirementRecord[] for display so the
 * sorting / grouping / badge logic is unit-testable without the host.
 */
import type { RequirementRecord, RequirementStatus, RequirementPriority } from '@kinqs/brainrouter-types';

/** Lifecycle order used to group + sort the list (live work first, archived last). */
const STATUS_ORDER: Record<RequirementStatus, number> = {
  draft: 0,
  clarifying: 1,
  ready: 2,
  'in-progress': 3,
  done: 4,
  archived: 5,
};

/** high → medium → low, so the most urgent requirement floats up within a status. */
const PRIORITY_ORDER: Record<RequirementPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Order requirements for the list: newest-first is the store's order, but the
 * panel surfaces active work over archived, then higher priority, then newest.
 * Pure + stable — never mutates the input array.
 */
export function sortRequirements(records: RequirementRecord[]): RequirementRecord[] {
  return [...records].sort((a, b) => {
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (s !== 0) return s;
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Count of requirements that are not done/archived — the openable-view badge. */
export function activeRequirementCount(records: RequirementRecord[]): number {
  return records.filter((r) => r.status !== 'done' && r.status !== 'archived').length;
}

/** Severity class for a priority chip, reusing the panel's badge/severity styles. */
export function priorityClass(priority: RequirementPriority): string {
  if (priority === 'high') return 'high';
  if (priority === 'medium') return 'medium';
  return 'low';
}

/** Link totals for the detail view (tasks + artifacts + memory). */
export function linkCounts(r: RequirementRecord): { tasks: number; artifacts: number; memory: number; total: number } {
  const tasks = r.taskIds.length;
  const artifacts = r.artifactIds.length;
  const memory = r.linkedMemoryIds.length;
  return { tasks, artifacts, memory, total: tasks + artifacts + memory };
}

/** A compact one-line label for a list row: "req_1234 · ready · high". */
export function requirementSummary(r: RequirementRecord): string {
  return `${r.id} · ${r.status} · ${r.priority}`;
}

export const REQUIREMENT_STATUS_OPTIONS: RequirementStatus[] = ['draft', 'clarifying', 'ready', 'in-progress', 'done', 'archived'];
export const REQUIREMENT_PRIORITY_OPTIONS: RequirementPriority[] = ['low', 'medium', 'high'];
