/**
 * Wire-stable plan projection shared by agent hosts and presentation heads.
 *
 * Persistence and transition validation remain Core-owned. The protocol keeps
 * only the fields a CLI or Desktop needs to render durable phase progress.
 */
export type PlanStepStatusView = 'pending' | 'in_progress' | 'completed';

export type PlanPhaseStatusView =
  | 'pending'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'skipped';

export interface PlanStepView {
  id?: string;
  step: string;
  status: PlanStepStatusView;
  acceptance?: string;
  evidence?: string[];
}

export interface PlanPhaseView {
  id: string;
  title: string;
  status: PlanPhaseStatusView;
  dependsOn: string[];
  requiredSkillIds: string[];
  stepIds: string[];
  blockedReason?: string;
}

export interface PlanUpdateView {
  items: PlanStepView[];
  explanation?: string;
  revision?: number;
  phases?: PlanPhaseView[];
}

