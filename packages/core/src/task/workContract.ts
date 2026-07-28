/**
 * Work Contract v1's reference-only domain schema.
 *
 * The contract links authoritative stores; it never copies requirement,
 * artifact, evidence, review, or plan bodies. Validation is pure and bounded so
 * CLI, Desktop, and future backend adapters share the same invariants.
 */

export const WORK_CONTRACT_SCHEMA_VERSION = 1;

export type WorkContractStatus =
  | 'draft'
  | 'approved'
  | 'active'
  | 'blocked'
  | 'review'
  | 'complete';

export type WorkTaskStatus = 'pending' | 'in_progress' | 'completed';
export type WorkTaskReadiness = 'draft' | 'exploratory' | 'implementation_ready';
export type WorkReviewDisposition =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'verified'
  | 'rejected';

export interface WorkRecordRef {
  id: string;
  contentHash?: string;
  revision?: number;
}

export interface WorkPlanRef extends WorkRecordRef {
  revision: number;
  contentHash: string;
}

export interface WorkTaskRef {
  id: string;
  planItemId: string;
  status: WorkTaskStatus;
  readiness: WorkTaskReadiness;
  requirementIds: string[];
  acceptanceCriterionIds: string[];
  decisionIds: string[];
  dependencyTaskIds: string[];
  affectedPaths: string[];
  expectedArtifactTypes: string[];
  expectedEvidenceTypes: string[];
  stageId?: string;
  personaId?: string;
  roleId?: string;
  skillIds: string[];
  toolPolicyHash?: string;
  exploratoryParentTaskId?: string;
  completionEvidenceIds: string[];
  reviewDisposition?: WorkReviewDisposition;
}

export interface SteeringReceipt {
  id: string;
  source: 'user' | 'parent' | 'extension';
  classification: 'clarification' | 'plan_change' | 'evidence' | 'goal_conflict';
  receivedAt: string;
  appliedAt?: string;
  priorRevision: number;
  resultingRevision?: number;
  affectedRequirementIds: string[];
  affectedTaskIds: string[];
  summary: string;
  status: 'pending' | 'applied' | 'rejected' | 'needs_user';
}

export interface WorkContract {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  sessionKey: string;
  profileId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  goal?: WorkRecordRef;
  requirements: WorkRecordRef[];
  decisions: WorkRecordRef[];
  plan: WorkPlanRef;
  tasks: WorkTaskRef[];
  evidence: WorkRecordRef[];
  artifacts: WorkRecordRef[];
  reviews: WorkRecordRef[];
  steering: SteeringReceipt[];
  status: WorkContractStatus;
}

const MAX_COLLECTION_ITEMS = 512;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const MAX_SUMMARY_LENGTH = 4_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const WORK_CONTRACT_STATUSES = new Set<WorkContractStatus>([
  'draft', 'approved', 'active', 'blocked', 'review', 'complete',
]);
const TASK_STATUSES = new Set<WorkTaskStatus>(['pending', 'in_progress', 'completed']);
const TASK_READINESS = new Set<WorkTaskReadiness>([
  'draft', 'exploratory', 'implementation_ready',
]);
const REVIEW_DISPOSITIONS = new Set<WorkReviewDisposition>([
  'pending', 'approved', 'changes_requested', 'verified', 'rejected',
]);

/** Return every schema/invariant failure without throwing on the first one. */
export function validateWorkContract(value: unknown): string[] {
  if (!isRecord(value)) return ['Work Contract must be an object.'];
  const errors: string[] = [];
  if (value.schemaVersion !== WORK_CONTRACT_SCHEMA_VERSION) {
    errors.push('Work Contract schemaVersion must be 1.');
  }
  validateId(value.id, 'id', errors);
  validateId(value.workspaceId, 'workspaceId', errors);
  validateId(value.sessionKey, 'sessionKey', errors);
  validateId(value.profileId, 'profileId', errors);
  validateRevision(value.revision, 'revision', errors, 1);
  validateTimestamp(value.createdAt, 'createdAt', errors);
  validateTimestamp(value.updatedAt, 'updatedAt', errors);
  if (!WORK_CONTRACT_STATUSES.has(value.status as WorkContractStatus)) {
    errors.push('status is invalid.');
  }
  if (value.goal !== undefined) validateRecordRef(value.goal, 'goal', errors);
  validateRefArray(value.requirements, 'requirements', errors);
  validateRefArray(value.decisions, 'decisions', errors);
  validatePlanRef(value.plan, errors);
  validateTaskArray(value.tasks, errors);
  validateRefArray(value.evidence, 'evidence', errors);
  validateRefArray(value.artifacts, 'artifacts', errors);
  validateRefArray(value.reviews, 'reviews', errors);
  validateSteeringArray(value.steering, errors);
  return errors;
}

/** Narrow an unknown value or fail with one bounded validation message. */
export function assertWorkContract(value: unknown): asserts value is WorkContract {
  const errors = validateWorkContract(value);
  if (errors.length > 0) {
    throw new Error(`Invalid Work Contract: ${errors.slice(0, 8).join(' ')}`);
  }
}

function validateTaskArray(value: unknown, errors: string[]): void {
  if (!boundedArray(value, 'tasks', errors)) return;
  const ids = new Set<string>();
  const planItemIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const task = value[index];
    const label = `tasks[${index}]`;
    if (!isRecord(task)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    validateId(task.id, `${label}.id`, errors);
    validateId(task.planItemId, `${label}.planItemId`, errors);
    if (typeof task.id === 'string') {
      if (ids.has(task.id)) errors.push(`${label}.id must be unique.`);
      ids.add(task.id);
    }
    if (typeof task.planItemId === 'string') {
      if (planItemIds.has(task.planItemId)) errors.push(`${label}.planItemId must be unique.`);
      planItemIds.add(task.planItemId);
    }
    if (!TASK_STATUSES.has(task.status as WorkTaskStatus)) {
      errors.push(`${label}.status is invalid.`);
    }
    if (!TASK_READINESS.has(task.readiness as WorkTaskReadiness)) {
      errors.push(`${label}.readiness is invalid.`);
    }
    validateIdArray(task.requirementIds, `${label}.requirementIds`, errors);
    validateIdArray(task.acceptanceCriterionIds, `${label}.acceptanceCriterionIds`, errors);
    validateIdArray(task.decisionIds, `${label}.decisionIds`, errors);
    validateIdArray(task.dependencyTaskIds, `${label}.dependencyTaskIds`, errors);
    validatePathArray(task.affectedPaths, `${label}.affectedPaths`, errors);
    validateIdArray(task.expectedArtifactTypes, `${label}.expectedArtifactTypes`, errors);
    validateIdArray(task.expectedEvidenceTypes, `${label}.expectedEvidenceTypes`, errors);
    validateIdArray(task.skillIds, `${label}.skillIds`, errors);
    validateIdArray(task.completionEvidenceIds, `${label}.completionEvidenceIds`, errors);
    validateOptionalId(task.stageId, `${label}.stageId`, errors);
    validateOptionalId(task.personaId, `${label}.personaId`, errors);
    validateOptionalId(task.roleId, `${label}.roleId`, errors);
    validateOptionalId(task.exploratoryParentTaskId, `${label}.exploratoryParentTaskId`, errors);
    if (task.toolPolicyHash !== undefined) {
      validateHash(task.toolPolicyHash, `${label}.toolPolicyHash`, errors);
    }
    if (
      task.reviewDisposition !== undefined &&
      !REVIEW_DISPOSITIONS.has(task.reviewDisposition as WorkReviewDisposition)
    ) {
      errors.push(`${label}.reviewDisposition is invalid.`);
    }
    validateImplementationReadiness(task, label, errors);
  }
  for (let index = 0; index < value.length; index += 1) {
    const task = value[index];
    if (!isRecord(task)) continue;
    const label = `tasks[${index}]`;
    if (
      typeof task.exploratoryParentTaskId === 'string' &&
      !ids.has(task.exploratoryParentTaskId)
    ) {
      errors.push(`${label}.exploratoryParentTaskId must reference a task in this contract.`);
    }
    if (Array.isArray(task.dependencyTaskIds)) {
      task.dependencyTaskIds.forEach((dependencyId, dependencyIndex) => {
        if (typeof dependencyId === 'string' && !ids.has(dependencyId)) {
          errors.push(
            `${label}.dependencyTaskIds[${dependencyIndex}] must reference a task in this contract.`,
          );
        }
      });
    }
  }
}

function validateImplementationReadiness(
  task: Record<string, unknown>,
  label: string,
  errors: string[],
): void {
  if (task.readiness !== 'implementation_ready') return;
  const hasRequirement = Array.isArray(task.requirementIds) && task.requirementIds.length > 0;
  const hasCriterion = Array.isArray(task.acceptanceCriterionIds) &&
    task.acceptanceCriterionIds.length > 0;
  const hasExploratoryParent = typeof task.exploratoryParentTaskId === 'string' &&
    task.exploratoryParentTaskId.trim().length > 0;
  if (!hasRequirement && !hasCriterion && !hasExploratoryParent) {
    errors.push(
      `${label} cannot be implementation_ready without a requirement, criterion, or exploratory parent.`,
    );
  }
}

function validateSteeringArray(value: unknown, errors: string[]): void {
  if (!boundedArray(value, 'steering', errors)) return;
  for (let index = 0; index < value.length; index += 1) {
    const receipt = value[index];
    const label = `steering[${index}]`;
    if (!isRecord(receipt)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    validateId(receipt.id, `${label}.id`, errors);
    if (!['user', 'parent', 'extension'].includes(String(receipt.source))) {
      errors.push(`${label}.source is invalid.`);
    }
    if (!['clarification', 'plan_change', 'evidence', 'goal_conflict'].includes(
      String(receipt.classification),
    )) {
      errors.push(`${label}.classification is invalid.`);
    }
    validateTimestamp(receipt.receivedAt, `${label}.receivedAt`, errors);
    if (receipt.appliedAt !== undefined) {
      validateTimestamp(receipt.appliedAt, `${label}.appliedAt`, errors);
    }
    validateRevision(receipt.priorRevision, `${label}.priorRevision`, errors, 0);
    if (receipt.resultingRevision !== undefined) {
      validateRevision(receipt.resultingRevision, `${label}.resultingRevision`, errors, 1);
    }
    validateIdArray(receipt.affectedRequirementIds, `${label}.affectedRequirementIds`, errors);
    validateIdArray(receipt.affectedTaskIds, `${label}.affectedTaskIds`, errors);
    if (typeof receipt.summary !== 'string' || receipt.summary.length > MAX_SUMMARY_LENGTH) {
      errors.push(`${label}.summary must be a bounded string.`);
    }
    if (!['pending', 'applied', 'rejected', 'needs_user'].includes(String(receipt.status))) {
      errors.push(`${label}.status is invalid.`);
    }
  }
}

function validatePlanRef(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('plan must be an object.');
    return;
  }
  validateId(value.id, 'plan.id', errors);
  validateRevision(value.revision, 'plan.revision', errors, 0);
  validateHash(value.contentHash, 'plan.contentHash', errors);
}

function validateRefArray(value: unknown, label: string, errors: string[]): void {
  if (!boundedArray(value, label, errors)) return;
  value.forEach((entry, index) => validateRecordRef(entry, `${label}[${index}]`, errors));
}

function validateRecordRef(value: unknown, label: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  validateId(value.id, `${label}.id`, errors);
  if (value.contentHash !== undefined) {
    validateHash(value.contentHash, `${label}.contentHash`, errors);
  }
  if (value.revision !== undefined) {
    validateRevision(value.revision, `${label}.revision`, errors, 0);
  }
}

function validateIdArray(value: unknown, label: string, errors: string[]): void {
  if (!boundedArray(value, label, errors)) return;
  value.forEach((entry, index) => validateId(entry, `${label}[${index}]`, errors));
}

function validatePathArray(value: unknown, label: string, errors: string[]): void {
  if (!boundedArray(value, label, errors)) return;
  value.forEach((entry, index) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_PATH_LENGTH ||
      entry.startsWith('/') ||
      entry.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(entry) ||
      entry.split(/[\\/]/).includes('..')
    ) {
      errors.push(`${label}[${index}] must be a bounded workspace-relative path.`);
    }
  });
}

function boundedArray(value: unknown, label: string, errors: string[]): value is unknown[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    errors.push(`${label} must be an array with at most ${MAX_COLLECTION_ITEMS} items.`);
    return false;
  }
  return true;
}

function validateOptionalId(value: unknown, label: string, errors: string[]): void {
  if (value !== undefined) validateId(value, label, errors);
}

function validateId(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID_LENGTH) {
    errors.push(`${label} must be a bounded non-empty string.`);
  }
}

function validateHash(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    errors.push(`${label} must be a SHA-256 hex digest.`);
  }
}

function validateRevision(
  value: unknown,
  label: string,
  errors: string[],
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    errors.push(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
}

function validateTimestamp(value: unknown, label: string, errors: string[]): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    errors.push(`${label} must be an ISO timestamp.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
