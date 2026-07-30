/**
 * B1d — authenticated MCP entrypoint for bounded asynchronous DOCX knowledge ingest.
 * The binary payload is accepted only as canonical base64 and is delegated to
 * the shared service boundary; responses never expose content or queue ids.
 */

import { z } from "zod";
import { MAX_KNOWLEDGE_DOCX_BASE64_CHARS } from "../../knowledge/contracts/document.js";
import {
  knowledgeDocumentOperations,
  knowledgeDocumentToolFailure,
  knowledgeDocumentToolResult,
  knowledgeProjectBaseInput,
  toKnowledgeDocumentView,
  type KnowledgeDocumentToolOptions,
} from "./document-tool-shared.js";

export const knowledgeIngestDocxToolSchema = {
  name: "knowledge_ingest_docx",
  description: "Accept one canonical base64 DOCX for asynchronous local ingest into an accessible Project knowledge base. URLs, host paths, and package relationships are never followed. Requires authenticated knowledge write access.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
      baseId: { type: "string", minLength: 1, maxLength: 256, description: "The knowledge base id within that Project." },
      title: { type: "string", minLength: 1, maxLength: 500, description: "Document title (1-500 characters)." },
      sourceName: { type: "string", maxLength: 500, description: "Optional source label (up to 500 characters)." },
      contentBase64: { type: "string", minLength: 8, maxLength: MAX_KNOWLEDGE_DOCX_BASE64_CHARS, description: "Canonical padded base64 for a DOCX up to 4 MiB decoded. Data URLs are rejected." },
    },
    required: ["projectId", "baseId", "title", "contentBase64"],
    additionalProperties: false,
  },
} as const;

const ingestDocxInput = knowledgeProjectBaseInput.extend({
  title: z.string().min(1).max(500),
  sourceName: z.string().max(500).optional(),
  contentBase64: z.string().min(8).max(MAX_KNOWLEDGE_DOCX_BASE64_CHARS),
});

export async function handleKnowledgeIngestDocx(args: unknown, options: KnowledgeDocumentToolOptions) {
  const params = ingestDocxInput.parse(args ?? {});
  try {
    const result = await knowledgeDocumentOperations(options).ingestDocx(
      options.actor,
      params.projectId,
      params.baseId,
      {
        title: params.title,
        sourceName: params.sourceName,
        contentBase64: params.contentBase64,
      },
    );
    if (!result.ok) return knowledgeDocumentToolFailure(result);
    return knowledgeDocumentToolResult({
      document: toKnowledgeDocumentView(result.value.document),
      created: result.value.created,
    });
  } catch {
    return knowledgeDocumentToolFailure({ ok: false, code: "internal_error" });
  }
}
