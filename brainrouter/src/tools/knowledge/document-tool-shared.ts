/**
 * B1b — shared transport helpers for authenticated knowledge-document MCP tools.
 * The helpers keep every tool on the same content-free response contract while
 * leaving each advertised schema and handler in its own registry module.
 */

import { z } from "zod";
import type { KnowledgeActor } from "../../knowledge/contracts/actor.js";
import type {
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryView,
  KnowledgeDocumentServiceFailure,
  KnowledgeDocumentServiceResult,
  KnowledgeDocumentStatusView,
  IngestKnowledgeDocxInput,
  IngestKnowledgePdfInput,
  IngestKnowledgeTextInput,
} from "../../knowledge/contracts/document.js";
import { KnowledgeDocumentService } from "../../knowledge/services/documents.js";
import { memoryEngine } from "../../memory/engine.js";

export interface KnowledgeDocumentToolOperations {
  ingestDocx(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgeDocxInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>>;
  ingestPdf(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgePdfInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>>;
  ingestText(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgeTextInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>>;
  status(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentStatusView>>;
  retry(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentRetryView>>;
}

export interface KnowledgeDocumentToolOptions {
  actor: KnowledgeActor;
  service?: KnowledgeDocumentToolOperations;
}

export const knowledgeProjectBaseInput = z.object({
  projectId: z.string().trim().min(1).max(256),
  baseId: z.string().trim().min(1).max(256),
});

export const knowledgeDocumentScopeInput = knowledgeProjectBaseInput.extend({
  documentId: z.string().trim().min(1).max(256),
});

export function knowledgeDocumentOperations(
  options: KnowledgeDocumentToolOptions,
): KnowledgeDocumentToolOperations {
  return options.service ?? new KnowledgeDocumentService(memoryEngine.knowledge);
}

export function knowledgeDocumentToolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function knowledgeDocumentToolFailure(
  failure: KnowledgeDocumentServiceFailure | { ok: false; code: "internal_error" },
) {
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code: failure.code,
          ...(failure.code !== "internal_error" && failure.field ? { field: failure.field } : {}),
        },
      }),
    }],
  };
}

export function toKnowledgeDocumentView(record: KnowledgeDocumentRecord) {
  return {
    documentId: record.documentId,
    title: record.title,
    sourceName: record.sourceName,
    sourceFormat: record.sourceFormat,
    status: record.status,
    statusMessage: record.statusMessage,
    parseVersion: record.parseVersion,
    updatedAt: record.updatedAt,
    readyAt: record.readyAt,
  };
}
