/**
 * B1b — authenticated MCP entrypoint for exact-scope knowledge processing retry.
 * It exposes only whether work was reused or enqueued and never accepts or
 * returns a generic queue job identifier.
 */

import {
  knowledgeDocumentOperations,
  knowledgeDocumentScopeInput,
  knowledgeDocumentToolFailure,
  knowledgeDocumentToolResult,
  type KnowledgeDocumentToolOptions,
} from "./document-tool-shared.js";

export const knowledgeRetryToolSchema = {
  name: "knowledge_retry",
  description: "Retry processing for one exact document in an accessible Project knowledge base. Requires authenticated knowledge write access.",
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

export async function handleKnowledgeRetry(args: unknown, options: KnowledgeDocumentToolOptions) {
  const params = knowledgeDocumentScopeInput.parse(args ?? {});
  try {
    const result = await knowledgeDocumentOperations(options).retry(
      options.actor,
      params.projectId,
      params.baseId,
      params.documentId,
    );
    if (!result.ok) return knowledgeDocumentToolFailure(result);
    return knowledgeDocumentToolResult({ retry: result.value });
  } catch {
    return knowledgeDocumentToolFailure({ ok: false, code: "internal_error" });
  }
}
