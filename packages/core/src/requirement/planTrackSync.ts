import { getRequirement, linkRequirement, listRequirements, updateRequirement } from './requirementStore.js';
import { readPlan, seedPlanFromRequirement, type PlanItem } from '../task/taskStore.js';
import {
  createWorkItem,
  linkWorkItem,
  listWorkItems,
  transitionWorkItem,
} from '../track/trackStore.js';

export type PlanTrackSyncAction =
  | {
    kind: 'plan-seeded';
    requirementId: string;
    title: string;
  }
  | {
    kind: 'work-item-created' | 'work-item-completed';
    requirementId: string;
    planItemId: string;
    workItemId: string;
    workItemKey: string;
    title: string;
  };

export interface PlanTrackSyncResult {
  actions: PlanTrackSyncAction[];
}

function normalizePlanStep(step: string): string {
  return step
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'item';
}

/**
 * A CONTENT-derived link id (not positional), so it survives the model
 * rewriting/reordering its plan via update_plan. Keyed on the normalized step
 * text scoped to the requirement — re-running after an insert/reorder still
 * matches the existing work item instead of double-creating one. (Index-based
 * keys broke on any plan edit; the store has no persisted plan-item id yet.)
 */
export function planItemId(requirementId: string, item: PlanItem): string {
  return `plan:${requirementId}:${normalizePlanStep(item.step)}`;
}

/**
 * Deterministically reconcile one session's ready/in-progress requirement,
 * plan, and Track items. This mutates only existing stores and is idempotent:
 * re-running it cannot create another item for the same requirement plan ref.
 */
export function syncRequirementPlanTrack(
  workspaceRoot: string,
  sessionKey: string,
): PlanTrackSyncResult {
  const actions: PlanTrackSyncAction[] = [];
  let plan = readPlan(workspaceRoot, sessionKey);
  let requirement = plan.requirementId
    ? getRequirement(workspaceRoot, plan.requirementId)
    : undefined;

  if (!requirement && plan.items.length === 0) {
    requirement = listRequirements(workspaceRoot, { sessionKey })
      .find((record) => record.status === 'ready' && record.acceptanceCriteria.length > 0);
  }
  if (!requirement || (requirement.status !== 'ready' && requirement.status !== 'in-progress')) {
    return { actions };
  }

  if (plan.items.length === 0 && requirement.status === 'ready') {
    if (requirement.acceptanceCriteria.length === 0) return { actions };
    plan = seedPlanFromRequirement(workspaceRoot, requirement, sessionKey);
    updateRequirement(workspaceRoot, requirement.id, { status: 'in-progress' });
    requirement = getRequirement(workspaceRoot, requirement.id) ?? requirement;
    actions.push({ kind: 'plan-seeded', requirementId: requirement.id, title: requirement.title });
  } else if (plan.requirementId !== requirement.id) {
    return { actions };
  } else if (requirement.status === 'ready') {
    updateRequirement(workspaceRoot, requirement.id, { status: 'in-progress' });
    requirement = getRequirement(workspaceRoot, requirement.id) ?? requirement;
  }

  const workItems = listWorkItems(workspaceRoot);
  for (const item of plan.items) {
    const id = planItemId(requirement.id, item);
    let workItem = workItems.find((candidate) =>
      candidate.requirementId === requirement.id && candidate.taskIds.includes(id),
    );
    if (!workItem) {
      workItem = createWorkItem(workspaceRoot, {
        title: item.step,
        description: item.acceptance,
        sessionKey,
        requirementId: requirement.id,
        actor: 'agent',
      });
      workItem = linkWorkItem(workspaceRoot, workItem.id, { taskIds: [id] }) ?? workItem;
      linkRequirement(workspaceRoot, requirement.id, { taskId: id });
      workItems.push(workItem);
      actions.push({
        kind: 'work-item-created',
        requirementId: requirement.id,
        planItemId: id,
        workItemId: workItem.id,
        workItemKey: workItem.key,
        title: workItem.title,
      });
    }
    if (item.status === 'completed' && workItem.statusCategory !== 'completed') {
      const completed = transitionWorkItem(workspaceRoot, workItem.id, 'done', 'agent');
      if (completed) {
        actions.push({
          kind: 'work-item-completed',
          requirementId: requirement.id,
          planItemId: id,
          workItemId: completed.id,
          workItemKey: completed.key,
          title: completed.title,
        });
      }
    }
  }

  return { actions };
}
