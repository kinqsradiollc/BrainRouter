import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

export const memoryRecallToolSchema = {
  name: "memory_recall",
  description: "Retrieve relevant memories, persona, and scene context before generating a response. Best used proactively when context is missing. Supports `filters` to scope results by type / scene / time range / minPriority / skillTag — apply them when the query is mid-conversation pivot or only one memory category is wanted.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "The ID of the user (enforces multi-tenant isolation)."
      },
      sessionKey: {
        type: "string",
        description: "A stable identifier for this conversation channel/session."
      },
      query: {
        type: "string",
        description: "The user's query or intent to recall memories for."
      },
      activeSkill: {
        type: "string",
        description: "The name of the BrainRouter skill currently being executed (if any)."
      },
      filters: {
        type: "object",
        description: "Optional filters narrowing the candidate pool before ranking.",
        properties: {
          types: { type: "array", items: { type: "string" }, description: "Whitelist of memory types (e.g. ['instruction', 'feedback'])." },
          scenes: { type: "array", items: { type: "string" }, description: "Whitelist of contextual focus scene names." },
          capturedAfter: { type: "string", description: "ISO 8601 lower bound on created_time." },
          capturedBefore: { type: "string", description: "ISO 8601 upper bound on created_time." },
          minPriority: { type: "number", description: "Drop records whose stored priority is below this threshold (0-100)." },
          skillTag: { type: "string", description: "Restrict to records produced under this skill tag." },
          workspaceTag: { type: "string", description: "Federation Stage 1 (0.4.0) — restrict to records captured in this workspace (16-char hash from workspaceTagFromPath). NULL-tolerant: records without a tag (legacy / pre-migration) surface in every workspace." }
        }
      }
    },
    required: ["sessionKey", "query"]
  }
} as const;

export async function handleMemoryRecall(args: any, options?: { defaultUserId?: string }) {
  const params = z.object({
    userId: z.string().optional(),
    sessionKey: z.string(),
    query: z.string(),
    activeSkill: z.string().optional(),
    filters: z.object({
      types: z.array(z.string()).optional(),
      scenes: z.array(z.string()).optional(),
      capturedAfter: z.string().optional(),
      capturedBefore: z.string().optional(),
      minPriority: z.number().optional(),
      skillTag: z.string().optional(),
      workspaceTag: z.string().optional(),
    }).optional()
  }).parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    if (params.activeSkill) {
      memoryEngine.spikeSkill(effectiveUserId, params.activeSkill);
    }

    const result = await memoryEngine.recall({
      userId: effectiveUserId,
      sessionKey: params.sessionKey,
      query: params.query,
      activeSkill: params.activeSkill,
      filters: params.filters,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Recall failed: ${err.message}` }]
    };
  }
}
