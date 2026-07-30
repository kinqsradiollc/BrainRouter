/** Authenticated MCP entrypoint for Project-scoped hybrid knowledge retrieval. */

import { z } from "zod";
import type { KnowledgeActor } from "../../knowledge/contracts/actor.js";
import {
  MAX_KNOWLEDGE_SEARCH_BASES,
  MAX_KNOWLEDGE_SEARCH_LIMIT,
  MAX_KNOWLEDGE_SEARCH_QUERY_CHARS,
  type KnowledgeSearchResult,
  type KnowledgeSearchServiceFailure,
  type KnowledgeSearchServiceResult,
  type SearchKnowledgeInput,
} from "../../knowledge/contracts/search.js";
import { KnowledgeSearchService } from "../../knowledge/services/search.js";
import { memoryEngine } from "../../memory/engine.js";

const MAX_SCOPE_ID_LENGTH = 512;

export interface KnowledgeSearchToolOperations {
  search(
    actor: KnowledgeActor,
    projectId: string,
    input: SearchKnowledgeInput,
  ): Promise<KnowledgeSearchServiceResult<KnowledgeSearchResult>>;
}

export interface KnowledgeSearchToolOptions {
  actor: KnowledgeActor;
  service?: KnowledgeSearchToolOperations;
}

export const knowledgeSearchToolSchema = {
  name: "knowledge_search",
  description: "Search ready documents in an accessible BrainRouter Project and return citation-bearing results. Uses lexical fallback when vector retrieval is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
      query: { type: "string", minLength: 1, maxLength: MAX_KNOWLEDGE_SEARCH_QUERY_CHARS, description: "Natural-language or keyword query." },
      baseIds: {
        type: "array",
        maxItems: MAX_KNOWLEDGE_SEARCH_BASES,
        items: { type: "string", minLength: 1, maxLength: MAX_SCOPE_ID_LENGTH },
        description: "Optional knowledge base ids within that Project. Omit to search every base.",
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_KNOWLEDGE_SEARCH_LIMIT, description: "Maximum result count." },
    },
    required: ["projectId", "query"],
    additionalProperties: false,
  },
} as const;

const searchInput = z.object({
  projectId: z.string().trim().min(1).max(256),
  query: z.string().trim().min(1).max(MAX_KNOWLEDGE_SEARCH_QUERY_CHARS),
  baseIds: z.array(z.string().trim().min(1).max(MAX_SCOPE_ID_LENGTH))
    .max(MAX_KNOWLEDGE_SEARCH_BASES)
    .optional(),
  limit: z.number().int().min(1).max(MAX_KNOWLEDGE_SEARCH_LIMIT).optional(),
});

export async function handleKnowledgeSearch(args: unknown, options: KnowledgeSearchToolOptions) {
  const params = searchInput.parse(args ?? {});
  try {
    const service = options.service ?? new KnowledgeSearchService(memoryEngine.knowledge, {
      resolveEmbeddingProvider: (orgId) => memoryEngine.resolveKnowledgeEmbeddingProvider(orgId),
    });
    const result = await service.search(options.actor, params.projectId, {
      query: params.query,
      baseIds: params.baseIds,
      limit: params.limit,
    });
    if (!result.ok) return knowledgeSearchToolFailure(result);
    return knowledgeSearchToolResult({ search: result.value });
  } catch {
    return knowledgeSearchToolFailure({ ok: false, code: "internal_error" });
  }
}

function knowledgeSearchToolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function knowledgeSearchToolFailure(
  failure: KnowledgeSearchServiceFailure | { ok: false; code: "internal_error" },
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
