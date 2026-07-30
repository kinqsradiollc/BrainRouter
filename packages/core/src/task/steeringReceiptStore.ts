/**
 * Steering receipt persistence at the model-safe input boundary.
 *
 * This module records delivery without deciding semantic intent. A later
 * reconciliation step classifies and resolves the pending receipt.
 */
import { loadWorkspaceManifest } from '../workspace/manifest.js';
import type { SteeringInput } from '../session/input/inputDelivery.js';
import { readPlan, type PlanState } from './taskStore.js';
import {
  createWorkContract,
  readWorkContract,
  reviseWorkContract,
} from './workContractStore.js';
import {
  projectContractStatus,
  mergeProjectedPlanTasks,
  projectPlanReference,
  projectPlanTasks,
} from './workContractProjection.js';
import type { SteeringReceipt, WorkContract } from './workContract.js';

const MAX_STEERING_SUMMARY_LENGTH = 240;

export type SteeringClassification = NonNullable<SteeringReceipt['classification']>;

export interface ReconcileSteeringReceiptInput {
  receiptId: string;
  classification: SteeringClassification;
  summary: string;
  affectedRequirementIds?: string[];
  affectedTaskIds?: string[];
  affectedPhaseIds?: string[];
}

export interface PendingSteeringConstraint {
  receiptId: string;
  phase: 'classify' | 'revise_plan';
}

export function beginSteeringReceipt(
  workspaceRoot: string,
  sessionKey: string,
  input: SteeringInput,
): SteeringReceipt {
  const current = ensureWorkContract(workspaceRoot, sessionKey);
  const existing = current.steering.find((receipt) => receipt.id === input.id);
  if (existing) return structuredClone(existing);

  const receipt: SteeringReceipt = {
    id: input.id,
    source: input.source,
    receivedAt: new Date(input.createdAt).toISOString(),
    priorRevision: current.plan.revision,
    affectedRequirementIds: [],
    affectedTaskIds: [],
    affectedPhaseIds: [],
    summary: summarizeSteer(input.text),
    status: 'pending',
  };
  const revised = reviseWorkContract(
    workspaceRoot,
    sessionKey,
    current.revision,
    (contract) => ({
      ...contract,
      steering: [...contract.steering, receipt],
    }),
  );
  return structuredClone(
    revised.steering.find((candidate) => candidate.id === input.id) ?? receipt,
  );
}

export function reconcileSteeringReceipt(
  workspaceRoot: string,
  sessionKey: string,
  input: ReconcileSteeringReceiptInput,
): SteeringReceipt {
  if (!['clarification', 'plan_change', 'evidence', 'goal_conflict'].includes(input.classification)) {
    throw new Error(`Invalid steering classification "${input.classification}".`);
  }
  const current = ensureWorkContract(workspaceRoot, sessionKey);
  const receipt = current.steering.find((candidate) => candidate.id === input.receiptId);
  if (!receipt) throw new Error(`Unknown steering receipt "${input.receiptId}".`);
  if (receipt.classification) return structuredClone(receipt);
  if (receipt.source === 'extension' && input.classification !== 'evidence') {
    throw new Error('Extension steering is evidence-only and cannot change plans or goals.');
  }
  const summary = summarizeSteer(input.summary);
  if (!summary) throw new Error('Steering reconciliation summary cannot be empty.');
  const affectedRequirementIds = uniqueIds(input.affectedRequirementIds);
  const affectedTaskIds = uniqueIds(input.affectedTaskIds);
  const affectedPhaseIds = uniqueIds(input.affectedPhaseIds);
  assertKnownIds(affectedRequirementIds, current.requirements.map((entry) => entry.id), 'requirement');
  assertKnownIds(affectedTaskIds, current.tasks.map((entry) => entry.id), 'task');
  assertKnownIds(
    affectedPhaseIds,
    readPlan(workspaceRoot, sessionKey).phases?.map((phase) => phase.id) ?? [],
    'phase',
  );
  const status: SteeringReceipt['status'] =
    input.classification === 'plan_change'
      ? 'pending'
      : input.classification === 'goal_conflict'
        ? 'needs_user'
        : 'applied';
  const now = new Date().toISOString();
  const revised = reviseWorkContract(
    workspaceRoot,
    sessionKey,
    current.revision,
    (contract) => ({
      ...contract,
      steering: contract.steering.map((candidate) => candidate.id === input.receiptId
        ? {
            ...candidate,
            classification: input.classification,
            summary,
            affectedRequirementIds,
            affectedTaskIds,
            affectedPhaseIds,
            status,
            ...(status === 'applied' ? { appliedAt: now } : {}),
          }
        : candidate),
    }),
  );
  return structuredClone(revised.steering.find((candidate) => candidate.id === input.receiptId)!);
}

export function applySteeringPlanRevision(
  workspaceRoot: string,
  sessionKey: string,
  receiptId: string,
  plan: PlanState,
): SteeringReceipt {
  const current = ensureWorkContract(workspaceRoot, sessionKey);
  const receipt = current.steering.find((candidate) => candidate.id === receiptId);
  if (!receipt) throw new Error(`Unknown steering receipt "${receiptId}".`);
  if (receipt.classification !== 'plan_change' || receipt.status !== 'pending') {
    throw new Error(`Steering receipt "${receiptId}" is not awaiting a plan revision.`);
  }
  const now = new Date().toISOString();
  const requirementRefs = plan.requirementId
    ? uniqueIds([
        ...current.requirements.map((entry) => entry.id),
        plan.requirementId,
      ]).map((id) => ({ id }))
    : current.requirements;
  const revised = reviseWorkContract(
    workspaceRoot,
    sessionKey,
    current.revision,
    (contract) => ({
      ...contract,
      requirements: requirementRefs,
      plan: projectPlanReference(sessionKey, plan),
      tasks: mergeProjectedPlanTasks(contract.tasks, plan),
      status: projectContractStatus(plan),
      steering: contract.steering.map((candidate) => candidate.id === receiptId
        ? {
            ...candidate,
            status: 'applied',
            appliedAt: now,
            resultingRevision: plan.revision,
          }
        : candidate),
    }),
  );
  return structuredClone(revised.steering.find((candidate) => candidate.id === receiptId)!);
}

export function pendingSteeringConstraint(
  workspaceRoot: string,
  sessionKey: string,
): PendingSteeringConstraint | null {
  const contract = readWorkContract(workspaceRoot, sessionKey);
  if (!contract) return null;
  const unclassified = contract.steering.find((receipt) =>
    receipt.status === 'pending' && !receipt.classification);
  if (unclassified) return { receiptId: unclassified.id, phase: 'classify' };
  const planChange = contract.steering.find((receipt) =>
    receipt.status === 'pending' && receipt.classification === 'plan_change');
  return planChange ? { receiptId: planChange.id, phase: 'revise_plan' } : null;
}

export function ensureWorkContract(
  workspaceRoot: string,
  sessionKey: string,
): WorkContract {
  const existing = readWorkContract(workspaceRoot, sessionKey);
  if (existing) return existing;

  const plan = readPlan(workspaceRoot, sessionKey);
  const requirementRefs = plan.requirementId ? [{ id: plan.requirementId }] : [];
  return createWorkContract(workspaceRoot, {
    sessionKey,
    profileId: loadWorkspaceManifest(workspaceRoot)?.profile ?? 'custom',
    requirements: requirementRefs,
    plan: projectPlanReference(sessionKey, plan),
    tasks: projectPlanTasks(plan),
    status: projectContractStatus(plan),
  });
}

function summarizeSteer(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_STEERING_SUMMARY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_STEERING_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function uniqueIds(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function assertKnownIds(values: string[], knownValues: string[], label: string): void {
  const known = new Set(knownValues);
  const unknown = values.find((value) => !known.has(value));
  if (unknown) throw new Error(`Unknown affected ${label} id "${unknown}".`);
}
