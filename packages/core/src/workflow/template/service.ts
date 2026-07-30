/**
 * Workflow service (ADR-008, Wave 2) — a stateless port over the pure workflow
 * run-state model (step/phase transitions, status derivation, glyph/duration
 * rendering) and template-plan builder. Additive and behaviour-preserving: every
 * method delegates to the existing workflow functions. No logic moved or removed.
 */
import {
  stepTemplateForKind, computeRunStatus, applyStepTransition, stepGlyph, formatRunGlyphs,
  formatDuration, summarizeRun, staleRunSlugs, computePhaseRunStatus, applyPhaseTransition,
  type WorkflowRun, type WorkflowRunStep, type WorkflowRunPhase,
  type RunStatus, type RunStepStatus, type RunPhaseStatus,
} from "../run/workflowRun.js";
import { buildTemplatePlan, type TemplateResult } from "./workflowTemplates.js";

/** Options accepted by {@link IWorkflowService.applyPhaseTransition}. */
export type PhaseTransitionOptions = Parameters<typeof applyPhaseTransition>[4];

/** The workflow run-model + template contract (all pure compute). */
export interface IWorkflowService {
  stepTemplate(kind: string): Array<{ id: string; title: string }>;
  computeRunStatus(steps: WorkflowRunStep[]): RunStatus;
  applyStepTransition(steps: WorkflowRunStep[], stepId: string, status: RunStepStatus, now: string, note?: string): WorkflowRunStep[];
  stepGlyph(status: RunStepStatus): string;
  formatGlyphs(run: WorkflowRun): string;
  formatDuration(startIso: string | undefined, endIso: string | undefined): string;
  summarizeRun(run: WorkflowRun): { done: number; total: number; current: string | null };
  staleRunSlugs(runs: WorkflowRun[], isAlive: (pid: number | null) => boolean): string[];
  computePhaseRunStatus(phases: WorkflowRunPhase[]): RunStatus;
  applyPhaseTransition(phases: WorkflowRunPhase[], phaseId: string, status: RunPhaseStatus, now: string, opts?: PhaseTransitionOptions): WorkflowRunPhase[];
  buildTemplatePlan(name: string, args: unknown): TemplateResult;
}

/** {@link IWorkflowService} backed by the in-process workflow model — delegates only. */
export class WorkflowService implements IWorkflowService {
  stepTemplate(kind: string): Array<{ id: string; title: string }> {
    return stepTemplateForKind(kind);
  }
  computeRunStatus(steps: WorkflowRunStep[]): RunStatus {
    return computeRunStatus(steps);
  }
  applyStepTransition(steps: WorkflowRunStep[], stepId: string, status: RunStepStatus, now: string, note?: string): WorkflowRunStep[] {
    return applyStepTransition(steps, stepId, status, now, note);
  }
  stepGlyph(status: RunStepStatus): string {
    return stepGlyph(status);
  }
  formatGlyphs(run: WorkflowRun): string {
    return formatRunGlyphs(run);
  }
  formatDuration(startIso: string | undefined, endIso: string | undefined): string {
    return formatDuration(startIso, endIso);
  }
  summarizeRun(run: WorkflowRun): { done: number; total: number; current: string | null } {
    return summarizeRun(run);
  }
  staleRunSlugs(runs: WorkflowRun[], isAlive: (pid: number | null) => boolean): string[] {
    return staleRunSlugs(runs, isAlive);
  }
  computePhaseRunStatus(phases: WorkflowRunPhase[]): RunStatus {
    return computePhaseRunStatus(phases);
  }
  applyPhaseTransition(phases: WorkflowRunPhase[], phaseId: string, status: RunPhaseStatus, now: string, opts?: PhaseTransitionOptions): WorkflowRunPhase[] {
    return opts === undefined
      ? applyPhaseTransition(phases, phaseId, status, now)
      : applyPhaseTransition(phases, phaseId, status, now, opts);
  }
  buildTemplatePlan(name: string, args: unknown): TemplateResult {
    return buildTemplatePlan(name, args);
  }
}

/** Construct a workflow service. */
export function createWorkflowService(): IWorkflowService {
  return new WorkflowService();
}
