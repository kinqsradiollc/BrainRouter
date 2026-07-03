/**
 * Attachment service (ADR-008, Wave 2) — a per-workspace port over the attachment
 * store and ingest pipeline. Additive and behaviour-preserving: every method
 * delegates to the existing attachment functions; `workspaceRoot` is bound at
 * construction (and injected into the ingest input). The detect / imageMeta /
 * pdfText helpers stay importable as module utilities. No logic moved or removed.
 */
import type { AttachmentRecord } from "@kinqs/brainrouter-types";
import {
  attachmentDir, safeAttachmentName, createAttachment, getAttachment, listAttachments,
  updateAttachment, linkAttachmentMemory,
  type CreateAttachmentInput, type AttachmentFilter, type AttachmentPatch,
} from "./store/attachmentStore.js";
import { ingestAttachment, attachmentContextMarkdown, type IngestAttachmentInput } from "./ingest/ingest.js";

/** Ingest input minus `workspaceRoot` (the service supplies it). */
export type IngestInput = Omit<IngestAttachmentInput, "workspaceRoot">;
/** Options accepted by {@link IAttachmentService.contextMarkdown}. */
export type ContextMarkdownOptions = Parameters<typeof attachmentContextMarkdown>[1];

/** The attachment store + ingest contract, scoped to one workspace. */
export interface IAttachmentService {
  dir(id: string): string;
  safeName(name: string): string;
  create(input: CreateAttachmentInput): AttachmentRecord;
  get(id: string): AttachmentRecord | undefined;
  list(filter?: AttachmentFilter): AttachmentRecord[];
  update(id: string, patch: AttachmentPatch): AttachmentRecord | undefined;
  linkMemory(id: string, memoryId: string): AttachmentRecord | undefined;
  ingest(input: IngestInput): Promise<AttachmentRecord>;
  contextMarkdown(record: AttachmentRecord, opts?: ContextMarkdownOptions): string;
}

/** {@link IAttachmentService} backed by the in-process attachment store — delegates only. */
export class AttachmentService implements IAttachmentService {
  constructor(private readonly workspaceRoot: string) {}
  dir(id: string): string {
    return attachmentDir(this.workspaceRoot, id);
  }
  safeName(name: string): string {
    return safeAttachmentName(name);
  }
  create(input: CreateAttachmentInput): AttachmentRecord {
    return createAttachment(this.workspaceRoot, input);
  }
  get(id: string): AttachmentRecord | undefined {
    return getAttachment(this.workspaceRoot, id);
  }
  list(filter?: AttachmentFilter): AttachmentRecord[] {
    return filter === undefined ? listAttachments(this.workspaceRoot) : listAttachments(this.workspaceRoot, filter);
  }
  update(id: string, patch: AttachmentPatch): AttachmentRecord | undefined {
    return updateAttachment(this.workspaceRoot, id, patch);
  }
  linkMemory(id: string, memoryId: string): AttachmentRecord | undefined {
    return linkAttachmentMemory(this.workspaceRoot, id, memoryId);
  }
  ingest(input: IngestInput): Promise<AttachmentRecord> {
    return ingestAttachment({ ...input, workspaceRoot: this.workspaceRoot });
  }
  contextMarkdown(record: AttachmentRecord, opts?: ContextMarkdownOptions): string {
    return attachmentContextMarkdown(record, opts);
  }
}

/** Construct an attachment service bound to a workspace. */
export function createAttachmentService(workspaceRoot: string): IAttachmentService {
  return new AttachmentService(workspaceRoot);
}
