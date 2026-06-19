import fs from 'node:fs';
import { getStateFile, getSessionStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
  /** PARITY-Q: optional acceptance cue — how this item is verified done. */
  acceptance?: string;
}

export interface PlanState {
  explanation?: string;
  updatedAt: string;
  items: PlanItem[];
  /**
   * 0.4.15 workflow — the requirement this plan is anchored to, when the plan
   * was seeded from (or later linked to) a RequirementRecord. Carried forward
   * across `update_plan` edits so the model rewriting its plan never drops the
   * requirement anchor. Plans/tasks are scoped by workspace + session key, and
   * by requirement id when applicable.
   */
  requirementId?: string;
}

const EMPTY_PLAN: PlanState = {
  updatedAt: '',
  items: [],
};

/**
 * Durable per-session plan. Lives at
 *   <workspace>/.brainrouter/cli/sessions/<encodedKey>/tasks.json
 *
 * Legacy callers that don't pass a sessionKey read/write the older workspace-
 * level `tasks.json` so existing workspaces keep their plan after the upgrade.
 */
export function readPlan(workspaceRoot: string, sessionKey?: string): PlanState {
  if (sessionKey) {
    const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'tasks.json');
    if (fs.existsSync(sessionPath)) {
      return readJsonFile<PlanState>(sessionPath, EMPTY_PLAN);
    }
  }
  return readJsonFile<PlanState>(getStateFile(workspaceRoot, 'tasks.json'), EMPTY_PLAN);
}

export function updatePlan(
  workspaceRoot: string,
  input: { explanation?: string; plan: PlanItem[]; requirementId?: string },
  sessionKey?: string,
): PlanState {
  if (!Array.isArray(input.plan)) {
    throw new Error('plan must be an array.');
  }

  const items = input.plan.map((item, index) => normalizePlanItem(item, index));
  if (items.filter(item => item.status === 'in_progress').length > 1) {
    throw new Error('At most one plan item can be in_progress.');
  }

  // Carry the requirement anchor forward: an explicit input.requirementId wins,
  // otherwise preserve whatever the current plan was anchored to so a routine
  // `update_plan` (which doesn't know about requirements) never drops it.
  const requirementId = input.requirementId ?? readPlan(workspaceRoot, sessionKey).requirementId;

  const state: PlanState = {
    explanation: typeof input.explanation === 'string' && input.explanation.trim()
      ? input.explanation.trim()
      : undefined,
    updatedAt: new Date().toISOString(),
    items,
    ...(requirementId ? { requirementId } : {}),
  };

  const filePath = sessionKey
    ? getSessionStateFile(workspaceRoot, sessionKey, 'tasks.json')
    : getStateFile(workspaceRoot, 'tasks.json');
  writeJsonFile(filePath, state);
  return state;
}

/**
 * Seed a session's plan from a requirement's acceptance criteria — one pending
 * plan item per criterion, the plan anchored to the requirement id. Decoupled
 * from the requirement contract: takes only the fields it needs so the plan
 * store never imports the requirement type.
 */
export function seedPlanFromRequirement(
  workspaceRoot: string,
  req: { id: string; acceptanceCriteria: string[] },
  sessionKey?: string,
): PlanState {
  const plan: PlanItem[] = req.acceptanceCriteria.map((c) => ({ step: c, status: 'pending' as const, acceptance: c }));
  return updatePlan(workspaceRoot, { plan, requirementId: req.id }, sessionKey);
}

export function formatPlan(state: PlanState): string {
  if (state.items.length === 0) {
    return 'No active plan.';
  }

  const lines = ['Current plan:'];
  if (state.explanation) {
    lines.push(state.explanation);
  }
  for (const item of state.items) {
    lines.push(`- [${statusMarker(item.status)}] ${item.step}${item.acceptance ? `  — ✓ ${item.acceptance}` : ''}`);
  }
  return lines.join('\n');
}

function normalizePlanItem(item: PlanItem, index: number): PlanItem {
  if (!item || typeof item !== 'object') {
    throw new Error(`Plan item ${index + 1} must be an object.`);
  }
  const step = typeof item.step === 'string' ? item.step.trim() : '';
  if (!step) {
    throw new Error(`Plan item ${index + 1} is missing a non-empty step.`);
  }
  const status = item.status;
  if (!isPlanItemStatus(status)) {
    throw new Error(`Plan item ${index + 1} has invalid status "${String(status)}".`);
  }
  const acceptance = typeof item.acceptance === 'string' && item.acceptance.trim()
    ? item.acceptance.trim()
    : undefined;
  return acceptance ? { step, status, acceptance } : { step, status };
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function statusMarker(status: PlanItemStatus): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '/';
  return ' ';
}
