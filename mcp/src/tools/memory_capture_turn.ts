import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";

export const memoryCaptureTurnToolSchema = {
  name: "memory_capture_turn",
  description: "Record a completed conversation turn for memory processing. Call this passively after every agent response to ensure accurate tracking.",
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
      sessionId: {
        type: "string",
        description: "An optional sub-session identifier."
      },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["user", "assistant", "tool"] },
            content: { type: "string" },
            timestamp: { type: "number", description: "Epoch timestamp in milliseconds" }
          },
          required: ["role", "content", "timestamp"]
        },
        description: "The new messages that occurred in this turn."
      },
      activeSkill: {
        type: "string",
        description: "The name of the BrainRouter skill currently being executed (if any)."
      },
      skillHints: {
        type: "string",
        description: "Skill-specific extraction hints provided by the active skill."
      }
    },
    required: ["sessionKey", "messages"]
  }
} as const;

export async function handleMemoryCaptureTurn(args: any, options?: { defaultUserId?: string }) {
  const params = z.object({
    userId: z.string().optional(),
    sessionKey: z.string(),
    sessionId: z.string().optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant", "tool"]),
      content: z.string(),
      timestamp: z.number()
    })),
    activeSkill: z.string().optional(),
    skillHints: z.string().optional()
  }).parse(args);
  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";

  try {
    const result = await memoryEngine.capture({
      userId: effectiveUserId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      messages: params.messages,
      activeSkill: params.activeSkill,
      skillHints: params.skillHints
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
      content: [{ type: "text", text: `Capture failed: ${err.message}` }]
    };
  }
}
