/**
 * Annotation service (ADR-008, Wave 2) — a per-workspace port over the
 * annotation store. Additive and behaviour-preserving: every method delegates to
 * the existing annotationStore functions; `workspaceRoot` is bound at
 * construction. No logic moved or removed.
 */
import type { AnnotationRecord, AnnotationStatus } from "@kinqs/brainrouter-types";
import {
  readAnnotationsAll, getAnnotation, createAnnotation, updateAnnotation,
  setStatus, addComment, listAnnotations, linkAnnotation, deleteAnnotation,
  type CreateAnnotationInput, type AnnotationPatch, type AnnotationFilter, type AnnotationLink,
} from "./annotationStore.js";

/** The annotation-records store contract, scoped to one workspace. */
export interface IAnnotationService {
  readAll(): Record<string, AnnotationRecord>;
  get(id: string): AnnotationRecord | undefined;
  create(input: CreateAnnotationInput): AnnotationRecord;
  update(id: string, patch: AnnotationPatch): AnnotationRecord | undefined;
  setStatus(id: string, status: AnnotationStatus): AnnotationRecord | undefined;
  addComment(id: string, body: string, author?: string): AnnotationRecord | undefined;
  list(filter?: AnnotationFilter): AnnotationRecord[];
  link(id: string, link: AnnotationLink): AnnotationRecord | undefined;
  delete(id: string): boolean;
}

/** {@link IAnnotationService} backed by the in-process annotation store — delegates only. */
export class AnnotationService implements IAnnotationService {
  constructor(private readonly workspaceRoot: string) {}
  readAll(): Record<string, AnnotationRecord> {
    return readAnnotationsAll(this.workspaceRoot);
  }
  get(id: string): AnnotationRecord | undefined {
    return getAnnotation(this.workspaceRoot, id);
  }
  create(input: CreateAnnotationInput): AnnotationRecord {
    return createAnnotation(this.workspaceRoot, input);
  }
  update(id: string, patch: AnnotationPatch): AnnotationRecord | undefined {
    return updateAnnotation(this.workspaceRoot, id, patch);
  }
  setStatus(id: string, status: AnnotationStatus): AnnotationRecord | undefined {
    return setStatus(this.workspaceRoot, id, status);
  }
  addComment(id: string, body: string, author?: string): AnnotationRecord | undefined {
    return addComment(this.workspaceRoot, id, body, author);
  }
  list(filter?: AnnotationFilter): AnnotationRecord[] {
    return listAnnotations(this.workspaceRoot, filter);
  }
  link(id: string, link: AnnotationLink): AnnotationRecord | undefined {
    return linkAnnotation(this.workspaceRoot, id, link);
  }
  delete(id: string): boolean {
    return deleteAnnotation(this.workspaceRoot, id);
  }
}

/** Construct an annotation service bound to a workspace. */
export function createAnnotationService(workspaceRoot: string): IAnnotationService {
  return new AnnotationService(workspaceRoot);
}
