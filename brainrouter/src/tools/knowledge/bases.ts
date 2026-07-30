import { z } from "zod";
import { memoryEngine } from "../../memory/engine.js";
import type { KnowledgeActor } from "../../knowledge/contracts/actor.js";
import type {
  KnowledgeBaseRecord,
  KnowledgeServiceFailure,
  KnowledgeServiceResult,
} from "../../knowledge/contracts/base.js";
import { KnowledgeBaseService } from "../../knowledge/services/bases.js";

export const knowledgeListToolSchema = {
  name: "knowledge_list",
  description: "List the knowledge bases available in one accessible Project. Read-only and organization-scoped from the authenticated MCP session.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
} as const;

export const knowledgeBaseCreateToolSchema = {
  name: "knowledge_base_create",
  description: "Create a knowledge base in one accessible Project. Requires the authenticated MCP session to have knowledge write access.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, maxLength: 256, description: "The existing BrainRouter Project id." },
      name: { type: "string", minLength: 1, maxLength: 200, description: "Knowledge base name (1-200 characters)." },
      description: { type: "string", maxLength: 4_000, description: "Optional description (up to 4000 characters)." },
    },
    required: ["projectId", "name"],
    additionalProperties: false,
  },
} as const;

export interface KnowledgeBaseToolOperations {
  list(actor: KnowledgeActor, projectId: string): Promise<KnowledgeServiceResult<KnowledgeBaseRecord[]>>;
  create(
    actor: KnowledgeActor,
    projectId: string,
    input: { name: string; description?: string },
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>>;
}

export interface KnowledgeBaseToolOptions {
  actor: KnowledgeActor;
  service?: KnowledgeBaseToolOperations;
}

const projectInput = z.object({
  projectId: z.string().trim().min(1).max(256),
});

const createInput = projectInput.extend({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4_000).optional(),
});

export async function handleKnowledgeList(args: unknown, options: KnowledgeBaseToolOptions) {
  const params = projectInput.parse(args ?? {});
  try {
    const result = await operations(options).list(options.actor, params.projectId);
    if (!result.ok) return knowledgeToolFailure(result);
    return knowledgeToolResult({ bases: result.value.map(toKnowledgeBaseView) });
  } catch {
    return knowledgeToolFailure({ ok: false, code: "internal_error" });
  }
}

export async function handleKnowledgeBaseCreate(args: unknown, options: KnowledgeBaseToolOptions) {
  const params = createInput.parse(args ?? {});
  try {
    const result = await operations(options).create(options.actor, params.projectId, {
      name: params.name,
      description: params.description,
    });
    if (!result.ok) return knowledgeToolFailure(result);
    return knowledgeToolResult({ base: toKnowledgeBaseView(result.value) });
  } catch {
    return knowledgeToolFailure({ ok: false, code: "internal_error" });
  }
}

function operations(options: KnowledgeBaseToolOptions): KnowledgeBaseToolOperations {
  return options.service ?? new KnowledgeBaseService(memoryEngine.knowledge);
}

function knowledgeToolResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

type ToolFailure = KnowledgeServiceFailure | { ok: false; code: "internal_error" };

function knowledgeToolFailure(failure: ToolFailure) {
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code: failure.code, ...(failure.code !== "internal_error" && failure.field ? { field: failure.field } : {}) } }),
    }],
  };
}

function toKnowledgeBaseView(record: KnowledgeBaseRecord) {
  return {
    baseId: record.baseId,
    projectId: record.projectId,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
