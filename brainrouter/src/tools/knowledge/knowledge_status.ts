/**
 * B1b — authenticated MCP entrypoint for content-free knowledge processing status.
 * Status resolves the complete Project/base/document ancestry before returning
 * a transport-safe lifecycle view.
 */

import {
  knowledgeDocumentOperations,
  knowledgeDocumentScopeInput,
  knowledgeDocumentToolFailure,
  knowledgeDocumentToolResult,
  type KnowledgeDocumentToolOptions,
} from "./document-tool-shared.js";

export const knowledgeStatusToolSchema = {
  name: "knowledge_status",
  description: "Read content-free processing status for one document in an accessible Project knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
      baseId: { type: "string", minLength: 1, maxLength: 256, description: "The knowledge base id within that Project." },
      documentId: { type: "string", minLength: 1, maxLength: 256, description: "The document id within that knowledge base." },
    },
    required: ["projectId", "baseId", "documentId"],
    additionalProperties: false,
  },
} as const;

export async function handleKnowledgeStatus(args: unknown, options: KnowledgeDocumentToolOptions) {
  const params = knowledgeDocumentScopeInput.parse(args ?? {});
  try {
    const result = await knowledgeDocumentOperations(options).status(
      options.actor,
      params.projectId,
      params.baseId,
      params.documentId,
    );
    if (!result.ok) return knowledgeDocumentToolFailure(result);
    return knowledgeDocumentToolResult({ document: result.value });
  } catch {
    return knowledgeDocumentToolFailure({ ok: false, code: "internal_error" });
  }
}
