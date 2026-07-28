/**
 * Steering receipt persistence at the model-safe input boundary.
 *
 * This module records delivery without deciding semantic intent. A later
 * reconciliation step classifies and resolves the pending receipt.
 */
import { loadWorkspaceManifest } from '../workspace/manifest.js';
import type { SteeringInput } from '../session/input/inputDelivery.js';
import { readPlan } from './taskStore.js';
import {
  createWorkContract,
  readWorkContract,
  reviseWorkContract,
} from './workContractStore.js';
import {
  projectContractStatus,
  projectPlanReference,
  projectPlanTasks,
} from './workContractProjection.js';
import type { SteeringReceipt, WorkContract } from './workContract.js';

const MAX_STEERING_SUMMARY_LENGTH = 240;

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
    priorRevision: current.revision,
    affectedRequirementIds: [],
    affectedTaskIds: [],
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
