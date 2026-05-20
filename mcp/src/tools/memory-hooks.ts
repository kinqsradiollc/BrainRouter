import { z } from "zod";

import { processClaudeCodeHook } from "../integrations/claude-code.js";
import { processCodexHook } from "../integrations/codex.js";
import {
  buildHookResult,
  listHostHooks,
  processGenericMcpHook,
  registerHostHook,
} from "../integrations/generic-mcp.js";
import { memoryEngine } from "../memory/engine.js";

const hookSourceSchema = z.enum(["claude-code", "codex", "generic-mcp"]);

export const memoryHookToolSchemas = [
  {
    name: "memory_hook_register",
    description: "Register a passive host lifecycle hook source and optionally process one hook event into L0 memory.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["claude-code", "codex", "generic-mcp"] },
        events: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
        sessionKey: { type: "string" },
        sessionId: { type: "string" },
        workspacePath: { type: "string" },
        event: { type: "string", description: "Optional lifecycle event to process immediately." },
        payload: { type: "object", additionalProperties: true },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["source"],
    },
  },
  {
    name: "memory_hook_status",
    description: "List registered passive lifecycle hook sources and their last-seen timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["claude-code", "codex", "generic-mcp"] },
        userId: { type: "string" },
      },
    },
  },
] as const;

export async function handleMemoryHookTool(
  name: string,
  args: unknown,
  options?: { defaultUserId?: string },
) {
  switch (name) {
    case "memory_hook_register": {
      const params = z.object({
        source: hookSourceSchema,
        events: z.array(z.string()).optional(),
        userId: z.string().optional(),
        sessionKey: z.string().optional(),
        sessionId: z.string().optional(),
        workspacePath: z.string().optional(),
        event: z.string().optional(),
        payload: z.record(z.unknown()).optional(),
        metadata: z.record(z.unknown()).optional(),
      }).parse(args);
      const defaultUserId = options?.defaultUserId ?? "default";
      const userId = params.userId ?? defaultUserId;
      const hook = registerHostHook({
        userId,
        source: params.source,
        events: params.events,
        sessionKey: params.sessionKey,
        workspacePath: params.workspacePath,
        metadata: params.metadata,
      });

      if (!params.event) {
        return buildHookResult({ registered: hook });
      }

      const payload = {
        ...(params.payload ?? {}),
        event: params.event,
        userId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspacePath: params.workspacePath,
      };

      const captureResult = params.source === "claude-code"
        ? await processClaudeCodeHook(memoryEngine, payload, defaultUserId)
        : params.source === "codex"
          ? await processCodexHook(memoryEngine, payload, defaultUserId)
          : await processGenericMcpHook(memoryEngine, {
            source: "generic-mcp",
            event: params.event,
            userId,
            sessionKey: params.sessionKey ?? hook.sessionKey ?? "generic-mcp",
            sessionId: params.sessionId,
            workspacePath: params.workspacePath,
            args: params.payload,
            metadata: params.metadata,
          });

      return buildHookResult({ registered: hook, captureResult });
    }
    case "memory_hook_status": {
      const params = z.object({
        source: hookSourceSchema.optional(),
        userId: z.string().optional(),
      }).parse(args ?? {});
      const userId = params.userId ?? options?.defaultUserId ?? "default";
      const hooks = listHostHooks(userId).filter((hook) => !params.source || hook.source === params.source);
      return buildHookResult({ hooks });
    }
    default:
      throw new Error(`Unknown hook tool: ${name}`);
  }
}
