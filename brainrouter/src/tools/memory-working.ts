import { z } from "zod";
import {
  getWorkingContext,
  offloadWorkingPayload,
  resetWorkingMemory,
} from "../memory/working/offload.js";

function toolResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const baseWorkingInput = {
  workspacePath: z.string().optional(),
  userId: z.string().optional(),
  sessionKey: z.string().min(1),
};

export const memoryWorkingToolSchemas = [
  {
    name: "memory_working_context",
    description: "Return the current working-memory canvas and injected state block without raw payloads. Optionally fetch one raw ref by nodeId.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
        nodeId: { type: "string", description: "Optional ref node to fetch raw payload for." },
        activeNodeId: { type: "string", description: "Optional node to highlight in the returned Mermaid canvas." },
        contextWindowTokens: { type: "number" },
        estimatedTokens: { type: "number" },
      },
      required: ["sessionKey"],
    },
  },
  {
    name: "memory_working_offload",
    description: "Offload a large short-term working payload to .brainrouter/work refs and update step log, canvas, and injected state.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
        payload: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        kind: { type: "string" },
        contextWindowTokens: { type: "number" },
        estimatedTokens: { type: "number" },
        forceAggressive: { type: "boolean" },
      },
      required: ["sessionKey", "payload"],
    },
  },
  {
    name: "memory_working_reset",
    description: "Clear working memory files for a session after session end or when starting a clean task context.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        userId: { type: "string" },
        sessionKey: { type: "string" },
      },
      required: ["sessionKey"],
    },
  },
] as const;

export async function handleMemoryWorkingTool(
  name: string,
  args: unknown,
  options?: { defaultUserId?: string }
) {
  switch (name) {
    case "memory_working_context": {
      const params = z.object({
        ...baseWorkingInput,
        nodeId: z.string().optional(),
        activeNodeId: z.string().optional(),
        contextWindowTokens: z.number().int().positive().optional(),
        estimatedTokens: z.number().int().nonnegative().optional(),
      }).parse(args);
      const result = getWorkingContext(params.workspacePath, params.userId ?? options?.defaultUserId ?? "default", params.sessionKey, {
        nodeId: params.nodeId,
        activeNodeId: params.activeNodeId,
        contextWindowTokens: params.contextWindowTokens,
        estimatedTokens: params.estimatedTokens,
      });
      return toolResult(result);
    }
    case "memory_working_offload": {
      const params = z.object({
        ...baseWorkingInput,
        payload: z.string().min(1),
        title: z.string().optional(),
        summary: z.string().optional(),
        kind: z.string().optional(),
        contextWindowTokens: z.number().int().positive().optional(),
        estimatedTokens: z.number().int().nonnegative().optional(),
        forceAggressive: z.boolean().optional(),
      }).parse(args);
      return toolResult(offloadWorkingPayload({ ...params, userId: params.userId ?? options?.defaultUserId ?? "default" }));
    }
    case "memory_working_reset": {
      const params = z.object(baseWorkingInput).parse(args);
      return toolResult(resetWorkingMemory(params.workspacePath, params.userId ?? options?.defaultUserId ?? "default", params.sessionKey));
    }
    default:
      throw new Error(`Unknown working memory tool: ${name}`);
  }
}
