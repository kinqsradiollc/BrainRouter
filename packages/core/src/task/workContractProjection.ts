/**
 * Pure projections from the authoritative task plan into Work Contract refs.
 *
 * The contract deliberately stores hashes and stable identifiers rather than
 * duplicating plan prose.
 */
import crypto from 'node:crypto';

import { hashPlanState, type PlanState } from './taskStore.js';
import type { WorkContract, WorkTaskRef } from './workContract.js';

export function projectPlanReference(
  sessionKey: string,
  plan: PlanState,
): WorkContract['plan'] {
  return {
    id: opaqueHashId('plan', sessionKey),
    revision: plan.revision,
    contentHash: hashPlanState(plan),
  };
}

export function projectPlanTasks(plan: PlanState): WorkTaskRef[] {
  return plan.items.map((item): WorkTaskRef => ({
    id: item.id,
    planItemId: item.id,
    status: item.status,
    readiness: plan.requirementId ? 'implementation_ready' : 'draft',
    requirementIds: plan.requirementId ? [plan.requirementId] : [],
    acceptanceCriterionIds: [],
    decisionIds: [],
    dependencyTaskIds: [],
    affectedPaths: [],
    expectedArtifactTypes: [],
    expectedEvidenceTypes: [],
    skillIds: [],
    completionEvidenceIds: [],
  }));
}

export function projectContractStatus(plan: PlanState): WorkContract['status'] {
  if (!plan.requirementId) return 'draft';
  return plan.items.every((item) => item.status === 'completed') ? 'review' : 'active';
}

function opaqueHashId(prefix: string, value: string): string {
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}
