import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

export const memoryRecallToolSchema = {
  name: "memory_recall",
  description: "Retrieve relevant memories, persona, and scene context before generating a response. Best used proactively when context is missing.",
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
      }
    },
    required: ["userId", "sessionKey", "query"]
  }
} as const;

export async function handleMemoryRecall(args: any) {
  const params = z.object({
    userId: z.string(),
    sessionKey: z.string(),
    query: z.string(),
    activeSkill: z.string().optional()
  }).parse(args);

  try {
    const result = await memoryEngine.recall({
      userId: params.userId,
      sessionKey: params.sessionKey,
      query: params.query,
      activeSkill: params.activeSkill
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
