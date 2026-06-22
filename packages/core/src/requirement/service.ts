/**
 * Requirement service (ADR-008, Wave 2) — a per-workspace port over the
 * requirement store (with clarifying-question helpers). Additive and
 * behaviour-preserving: every method delegates to the existing requirementStore
 * functions; `workspaceRoot` is bound at construction. `openQuestions` is the one
 * pure helper folded in because it reads a record this service owns.
 */
import type { RequirementRecord, ClarifyingQA } from "@kinqs/brainrouter-types";
import {
  readRequirementsAll, getRequirement, createRequirement, updateRequirement,
  listRequirements, linkRequirement, openClarifyingQuestions,
  addClarifyingQuestion, answerClarifyingQuestion, setClarifyingQuestions, deleteRequirement,
  type CreateRequirementInput, type RequirementPatch, type RequirementFilter, type RequirementLink,
} from "./requirementStore.js";

/** The requirement store contract, scoped to one workspace. */
export interface IRequirementService {
  readAll(): Record<string, RequirementRecord>;
  get(id: string): RequirementRecord | undefined;
  create(input: CreateRequirementInput): RequirementRecord;
  update(id: string, patch: RequirementPatch): RequirementRecord | undefined;
  list(filter?: RequirementFilter): RequirementRecord[];
  link(id: string, link: RequirementLink): RequirementRecord | undefined;
  openQuestions(rec: RequirementRecord): ClarifyingQA[];
  addQuestion(id: string, question: string): RequirementRecord | null;
  answerQuestion(id: string, index: number, answer: string): RequirementRecord | null;
  setQuestions(id: string, qa: ClarifyingQA[]): RequirementRecord | null;
  delete(id: string): boolean;
}

/** {@link IRequirementService} backed by the in-process requirement store — delegates only. */
export class RequirementService implements IRequirementService {
  constructor(private readonly workspaceRoot: string) {}
  readAll(): Record<string, RequirementRecord> {
    return readRequirementsAll(this.workspaceRoot);
  }
  get(id: string): RequirementRecord | undefined {
    return getRequirement(this.workspaceRoot, id);
  }
  create(input: CreateRequirementInput): RequirementRecord {
    return createRequirement(this.workspaceRoot, input);
  }
  update(id: string, patch: RequirementPatch): RequirementRecord | undefined {
    return updateRequirement(this.workspaceRoot, id, patch);
  }
  list(filter?: RequirementFilter): RequirementRecord[] {
    return listRequirements(this.workspaceRoot, filter);
  }
  link(id: string, link: RequirementLink): RequirementRecord | undefined {
    return linkRequirement(this.workspaceRoot, id, link);
  }
  openQuestions(rec: RequirementRecord): ClarifyingQA[] {
    return openClarifyingQuestions(rec);
  }
  addQuestion(id: string, question: string): RequirementRecord | null {
    return addClarifyingQuestion(this.workspaceRoot, id, question);
  }
  answerQuestion(id: string, index: number, answer: string): RequirementRecord | null {
    return answerClarifyingQuestion(this.workspaceRoot, id, index, answer);
  }
  setQuestions(id: string, qa: ClarifyingQA[]): RequirementRecord | null {
    return setClarifyingQuestions(this.workspaceRoot, id, qa);
  }
  delete(id: string): boolean {
    return deleteRequirement(this.workspaceRoot, id);
  }
}

/** Construct a requirement service bound to a workspace. */
export function createRequirementService(workspaceRoot: string): IRequirementService {
  return new RequirementService(workspaceRoot);
}
