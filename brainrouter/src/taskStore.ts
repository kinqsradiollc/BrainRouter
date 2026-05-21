import { getCliStateFile, readJsonFile, writeJsonFile } from './cliState.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  step: string;
  status: PlanItemStatus;
}

export interface PlanState {
  explanation?: string;
  updatedAt: string;
  items: PlanItem[];
}

const EMPTY_PLAN: PlanState = {
  updatedAt: '',
  items: [],
};

export function readPlan(workspaceRoot: string): PlanState {
  return readJsonFile<PlanState>(getCliStateFile(workspaceRoot, 'tasks.json'), EMPTY_PLAN);
}

export function updatePlan(
  workspaceRoot: string,
  input: { explanation?: string; plan: PlanItem[] },
): PlanState {
  if (!Array.isArray(input.plan)) {
    throw new Error('plan must be an array.');
  }

  const items = input.plan.map((item, index) => normalizePlanItem(item, index));
  if (items.filter(item => item.status === 'in_progress').length > 1) {
    throw new Error('At most one plan item can be in_progress.');
  }

  const state: PlanState = {
    explanation: typeof input.explanation === 'string' && input.explanation.trim()
      ? input.explanation.trim()
      : undefined,
    updatedAt: new Date().toISOString(),
    items,
  };

  writeJsonFile(getCliStateFile(workspaceRoot, 'tasks.json'), state);
  return state;
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
    lines.push(`- [${statusMarker(item.status)}] ${item.step}`);
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
  return { step, status };
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function statusMarker(status: PlanItemStatus): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '/';
  return ' ';
}
