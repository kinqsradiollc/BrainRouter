import {
  createSprint,
  listSprints,
  listWorkItems,
  setSprintState,
  sprintVelocity,
  updateSprint,
  updateWorkItem,
} from './trackStore.js';

export type SprintAutomationAction =
  | { kind: 'sprint-created'; sprintId: string; sprintName: string }
  | { kind: 'work-item-assigned'; sprintId: string; workItemId: string; workItemKey: string; requirementId?: string }
  | { kind: 'sprint-completed'; sprintId: string; sprintName: string; velocity: number }
  // Propose-only suggestions (no store mutation) — a human makes the call.
  | { kind: 'sprint-suggested'; count: number }
  | { kind: 'sprint-complete-suggested'; sprintId: string; sprintName: string };

export interface SprintAutomationOptions {
  sessionKey: string;
  minItems: number;
  respectCapacity: boolean;
  /**
   * Default true. When proposing, the function only RETURNS suggestions
   * (`sprint-suggested` / `sprint-complete-suggested`) and never touches the
   * store — a human creates/starts/completes. When false (autopilot), it
   * auto-creates a future sprint + assigns + completes (still never auto-starts).
   */
  propose?: boolean;
}

function capacityAllows(
  assignedPoints: number,
  itemPoints: number,
  capacity: number | undefined,
  respectCapacity: boolean,
): boolean {
  return !respectCapacity || capacity === undefined || assignedPoints + itemPoints <= capacity;
}

/**
 * Reconcile one session's unassigned Track items into a conservative sprint
 * lifecycle. New sprints stay `future`; starting is always an explicit action.
 */
export function reconcileSessionSprints(
  workspaceRoot: string,
  options: SprintAutomationOptions,
): SprintAutomationAction[] {
  const propose = options.propose ?? true;
  const actions: SprintAutomationAction[] = [];
  const sprints = listSprints(workspaceRoot);
  const active = sprints.find((sprint) => sprint.state === 'active');

  if (active) {
    const assigned = listWorkItems(workspaceRoot, { sprintId: active.id });
    if (assigned.length > 0 && assigned.every((item) => item.statusCategory === 'done')) {
      if (propose) {
        actions.push({ kind: 'sprint-complete-suggested', sprintId: active.id, sprintName: active.name });
      } else {
        const velocity = sprintVelocity(workspaceRoot, active.id) ?? 0;
        updateSprint(workspaceRoot, active.id, { velocity });
        const completed = setSprintState(workspaceRoot, active.id, 'completed');
        if (completed) actions.push({ kind: 'sprint-completed', sprintId: completed.id, sprintName: completed.name, velocity });
      }
    }
  }

  const candidates = listWorkItems(workspaceRoot).filter((item) =>
    item.sessionKey === options.sessionKey
    && !!item.requirementId
    && !item.sprintId
    && item.statusCategory !== 'done',
  );
  if (candidates.length === 0) return actions;

  // Propose-only: suggest a sprint when enough ready items have nowhere to go.
  // Never create/assign — that's a human's one-click call.
  if (propose) {
    const hasSprint = sprints.some((sprint) => sprint.state === 'active' || sprint.state === 'future');
    if (!hasSprint && candidates.length >= options.minItems) {
      actions.push({ kind: 'sprint-suggested', count: candidates.length });
    }
    return actions;
  }

  const currentSprints = listSprints(workspaceRoot);
  let target = currentSprints.find((sprint) => sprint.state === 'active')
    ?? currentSprints.find((sprint) => sprint.state === 'future');
  if (!target && candidates.length >= options.minItems) {
    target = createSprint(workspaceRoot, {
      name: `Sprint ${currentSprints.length + 1}`,
      goal: `Deliver ${candidates.length} ready work item${candidates.length === 1 ? '' : 's'}`,
    });
    actions.push({ kind: 'sprint-created', sprintId: target.id, sprintName: target.name });
  }
  if (!target) return actions;

  let assignedPoints = listWorkItems(workspaceRoot, { sprintId: target.id })
    .reduce((total, item) => total + (item.storyPoints ?? 0), 0);
  for (const item of candidates) {
    const points = item.storyPoints ?? 0;
    if (!capacityAllows(assignedPoints, points, target.capacity, options.respectCapacity)) continue;
    const assigned = updateWorkItem(workspaceRoot, item.id, { sprintId: target.id }, 'agent');
    if (!assigned) continue;
    assignedPoints += points;
    actions.push({
      kind: 'work-item-assigned',
      sprintId: target.id,
      workItemId: assigned.id,
      workItemKey: assigned.key,
      requirementId: assigned.requirementId,
    });
  }

  return actions;
}
