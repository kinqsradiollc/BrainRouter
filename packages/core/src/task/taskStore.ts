/**
 * R1 (0.4.17) — durable per-session plan state and stable task identity.
 *
 * `tasks.json` remains the authoritative plan store. Schema v1 adds an opaque
 * host-owned id to every item plus a monotonically increasing revision. The
 * reader upgrades legacy files in place, while update reconciliation preserves
 * ids across normal model rewrites without trusting model-invented ids.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getStateFile, getSessionStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  /**
   * Stable host-owned identity. Optional on update input for compatibility;
   * every item returned by the store has one.
   */
  id?: string;
  step: string;
  status: PlanItemStatus;
  /** PARITY-Q: optional acceptance cue — how this item is verified done. */
  acceptance?: string;
}

export interface StoredPlanItem extends PlanItem {
  id: string;
}

export interface PlanState {
  schemaVersion: 1;
  revision: number;
  explanation?: string;
  updatedAt: string;
  items: StoredPlanItem[];
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
  schemaVersion: 1,
  revision: 0,
  updatedAt: '',
  items: [],
};

const PLAN_ITEM_ID_PATTERN = /^task_[a-z0-9_-]{8,80}$/i;

/**
 * Durable per-session plan. Lives at
 *   <workspace>/.brainrouter/cli/sessions/<encodedKey>/tasks.json
 *
 * Legacy callers that don't pass a sessionKey read/write the older workspace-
 * level `tasks.json` so existing workspaces keep their plan after the upgrade.
 */
export function readPlan(workspaceRoot: string, sessionKey?: string): PlanState {
  let filePath = getStateFile(workspaceRoot, 'tasks.json');
  if (sessionKey) {
    const sessionPath = getSessionStateFile(workspaceRoot, sessionKey, 'tasks.json');
    if (fs.existsSync(sessionPath)) {
      filePath = sessionPath;
    }
  }
  if (!fs.existsSync(filePath)) return EMPTY_PLAN;
  const raw = readJsonFile<unknown>(filePath, EMPTY_PLAN);
  const normalized = normalizePlanState(raw, filePath);
  if (normalized.migrated) {
    writeJsonFile(filePath, normalized.state);
  }
  return normalized.state;
}

export function updatePlan(
  workspaceRoot: string,
  input: { explanation?: string; plan: PlanItem[]; requirementId?: string },
  sessionKey?: string,
): PlanState {
  if (!Array.isArray(input.plan)) {
    throw new Error('plan must be an array.');
  }

  const current = readPlan(workspaceRoot, sessionKey);
  const items = reconcilePlanItems(input.plan, current.items);
  if (items.filter(item => item.status === 'in_progress').length > 1) {
    throw new Error('At most one plan item can be in_progress.');
  }

  // Carry the requirement anchor forward: an explicit input.requirementId wins,
  // otherwise preserve whatever the current plan was anchored to so a routine
  // `update_plan` (which doesn't know about requirements) never drops it.
  const requirementId = input.requirementId ?? current.requirementId;

  const state: PlanState = {
    schemaVersion: 1,
    revision: current.revision + 1,
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
    lines.push(
      `- [${statusMarker(item.status)}] ${item.step}` +
      `${item.acceptance ? `  — ✓ ${item.acceptance}` : ''}  [id: ${item.id}]`,
    );
  }
  return lines.join('\n');
}

/** Content-address one authoritative plan revision for Work Contract refs. */
export function hashPlanState(state: PlanState): string {
  const canonical = {
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    explanation: state.explanation,
    requirementId: state.requirementId,
    items: state.items.map((item) => ({
      id: item.id,
      step: item.step,
      status: item.status,
      acceptance: item.acceptance,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function reconcilePlanItems(input: PlanItem[], current: StoredPlanItem[]): StoredPlanItem[] {
  const normalized = input.map((item, index) => normalizePlanItem(item, index));
  const assigned = new Array<string | undefined>(normalized.length);
  const used = new Set<string>();
  const currentById = new Map(current.map((item) => [item.id, item]));

  for (let index = 0; index < normalized.length; index += 1) {
    const requested = normalized[index].id;
    if (requested && currentById.has(requested) && !used.has(requested)) {
      assigned[index] = requested;
      used.add(requested);
    }
  }

  for (let index = 0; index < normalized.length; index += 1) {
    if (assigned[index]) continue;
    const match = current.find((candidate) =>
      !used.has(candidate.id) && planItemFingerprint(candidate) === planItemFingerprint(normalized[index]),
    );
    if (match) {
      assigned[index] = match.id;
      used.add(match.id);
    }
  }

  for (let index = 0; index < normalized.length; index += 1) {
    if (assigned[index]) continue;
    const positional = current[index];
    if (positional && !used.has(positional.id)) {
      assigned[index] = positional.id;
      used.add(positional.id);
    }
  }

  return normalized.map((item, index) => ({
    ...item,
    id: assigned[index] ?? createPlanItemId(),
  }));
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
  const id = typeof item.id === 'string' && PLAN_ITEM_ID_PATTERN.test(item.id)
    ? item.id
    : undefined;
  return {
    ...(id ? { id } : {}),
    step,
    status,
    ...(acceptance ? { acceptance } : {}),
  };
}

function normalizePlanState(
  raw: unknown,
  filePath: string,
): { state: PlanState; migrated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: EMPTY_PLAN, migrated: false };
  }
  const record = raw as Partial<PlanState> & { items?: unknown };
  if (!Array.isArray(record.items)) {
    return { state: EMPTY_PLAN, migrated: false };
  }
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '';
  const items = record.items.map((item, index) => {
    const normalized = normalizePlanItem(item as PlanItem, index);
    return {
      ...normalized,
      id: normalized.id ?? migratedPlanItemId(filePath, updatedAt, normalized, index),
    };
  });
  const revision = Number.isSafeInteger(record.revision) && Number(record.revision) >= 0
    ? Number(record.revision)
    : 0;
  const state: PlanState = {
    schemaVersion: 1,
    revision,
    explanation: typeof record.explanation === 'string' && record.explanation.trim()
      ? record.explanation.trim()
      : undefined,
    updatedAt,
    items,
    ...(typeof record.requirementId === 'string' && record.requirementId.trim()
      ? { requirementId: record.requirementId.trim() }
      : {}),
  };
  const migrated = record.schemaVersion !== 1 ||
    record.revision !== revision ||
    items.some((item, index) => (record.items as PlanItem[])[index]?.id !== item.id);
  return { state, migrated };
}

function createPlanItemId(): string {
  return `task_${crypto.randomUUID().replaceAll('-', '')}`;
}

function migratedPlanItemId(
  filePath: string,
  updatedAt: string,
  item: PlanItem,
  index: number,
): string {
  const seed = JSON.stringify([filePath, updatedAt, index, item.step, item.acceptance ?? '']);
  return `task_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function planItemFingerprint(item: PlanItem): string {
  return JSON.stringify([item.step.trim(), item.acceptance?.trim() ?? '']);
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function statusMarker(status: PlanItemStatus): string {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '/';
  return ' ';
}
