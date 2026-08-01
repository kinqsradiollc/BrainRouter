/**
 * Dependency-free durable planning contracts shared across Core and hosts.
 *
 * Phases reference stable step IDs so persistence has one canonical copy of
 * each step while legacy consumers can continue reading the flat `items`
 * projection. Runtime validation and transition policy remain Core-owned.
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export type PlanPhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'skipped';

export interface PlanStep {
  id?: string;
  step: string;
  status: PlanStepStatus;
  acceptance?: string;
  evidence?: string[];
}

export interface StoredPlanStep extends PlanStep {
  id: string;
}

export interface PlanPhaseInput {
  id?: string;
  title: string;
  status: PlanPhaseStatus;
  dependsOn?: string[];
  requiredSkillIds?: string[];
  blockedReason?: string;
  steps: PlanStep[];
}

export interface StoredPlanPhase {
  id: string;
  title: string;
  status: PlanPhaseStatus;
  dependsOn: string[];
  requiredSkillIds: string[];
  stepIds: string[];
  blockedReason?: string;
}

export interface PlanSnapshot {
  schemaVersion: 1;
  revision: number;
  explanation?: string;
  updatedAt: string;
  items: StoredPlanStep[];
  phases?: StoredPlanPhase[];
  requirementId?: string;
}
