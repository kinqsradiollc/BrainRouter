/**
 * Shared Work Contract v1 data contracts.
 *
 * These dependency-free shapes cross core, CLI, Desktop, and protocol-facing
 * boundaries. Runtime validation and persistence stay with their owning
 * package so this leaf module remains safe for browser and Node consumers.
 */

export const WORK_CONTRACT_SCHEMA_VERSION = 1 as const;

export type WorkContractStatus =
  | "draft"
  | "approved"
  | "active"
  | "blocked"
  | "review"
  | "complete";

export type WorkTaskStatus = "pending" | "in_progress" | "completed";
export type WorkTaskReadiness = "draft" | "exploratory" | "implementation_ready";
export type WorkReviewDisposition =
  | "pending"
  | "approved"
  | "changes_requested"
  | "verified"
  | "rejected";

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
  source: "user" | "parent" | "extension";
  /**
   * Absent only while the receipt is pending semantic reconciliation.
   * Delivery to the model is not the same as accepting the steer.
   */
  classification?: "clarification" | "plan_change" | "evidence" | "goal_conflict";
  receivedAt: string;
  appliedAt?: string;
  priorRevision: number;
  resultingRevision?: number;
  affectedRequirementIds: string[];
  affectedTaskIds: string[];
  /** Durable plan phases explicitly changed or invalidated by this steer. */
  affectedPhaseIds?: string[];
  summary: string;
  status: "pending" | "applied" | "rejected" | "needs_user";
}

export interface WorkContract {
  schemaVersion: typeof WORK_CONTRACT_SCHEMA_VERSION;
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
