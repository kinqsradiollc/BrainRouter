/**
 * B1b — authenticated MCP entrypoint for bounded asynchronous knowledge text ingest.
 * The response intentionally exposes only lifecycle metadata, never persisted
 * content, custody fields, hashes, or the internal queue identifier.
 */

import { z } from "zod";
import { KNOWLEDGE_SOURCE_FORMATS, MAX_KNOWLEDGE_TEXT_BYTES } from "../../knowledge/contracts/document.js";
import {
  knowledgeDocumentOperations,
  knowledgeDocumentToolFailure,
  knowledgeDocumentToolResult,
  knowledgeProjectBaseInput,
  toKnowledgeDocumentView,
  type KnowledgeDocumentToolOptions,
} from "./document-tool-shared.js";

export const knowledgeIngestToolSchema = {
  name: "knowledge_ingest",
  description: "Accept plain text or Markdown for asynchronous ingest into one accessible Project knowledge base. Requires authenticated knowledge write access.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
      baseId: { type: "string", minLength: 1, maxLength: 256, description: "The knowledge base id within that Project." },
      title: { type: "string", minLength: 1, maxLength: 500, description: "Document title (1-500 characters)." },
      sourceName: { type: "string", maxLength: 500, description: "Optional source label (up to 500 characters)." },
      sourceFormat: { type: "string", enum: KNOWLEDGE_SOURCE_FORMATS, description: "Input format." },
      content: { type: "string", minLength: 1, maxLength: MAX_KNOWLEDGE_TEXT_BYTES, description: "Plain text or Markdown content (up to 2 MiB UTF-8)." },
    },
    required: ["projectId", "baseId", "title", "sourceFormat", "content"],
    additionalProperties: false,
  },
} as const;

const ingestInput = knowledgeProjectBaseInput.extend({
  title: z.string().min(1).max(500),
  sourceName: z.string().max(500).optional(),
  sourceFormat: z.enum(KNOWLEDGE_SOURCE_FORMATS),
  content: z.string().min(1).max(MAX_KNOWLEDGE_TEXT_BYTES),
});

export async function handleKnowledgeIngest(args: unknown, options: KnowledgeDocumentToolOptions) {
  const params = ingestInput.parse(args ?? {});
  try {
    const result = await knowledgeDocumentOperations(options).ingestText(
      options.actor,
      params.projectId,
      params.baseId,
      {
        title: params.title,
        sourceName: params.sourceName,
        sourceFormat: params.sourceFormat,
        content: params.content,
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
