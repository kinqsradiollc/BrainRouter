import { Router } from "express";
import { z } from "zod";

import { processClaudeCodeHook } from "../../integrations/claude-code.js";
import { processCodexHook } from "../../integrations/codex.js";
import {
  listHostHooks,
  processGenericMcpHook,
  registerHostHook,
} from "../../integrations/generic-mcp.js";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, scopedUserId, errorStatus, type AuthedRequest } from "../middleware/auth.js";

export const hooksRouter = Router();
hooksRouter.use(requireAnyAuth);

const hookSourceSchema = z.enum(["claude-code", "codex", "generic-mcp"]);

const scopeHooks = (req: AuthedRequest, requested?: unknown) => scopedUserId(req, requested, "hooks");

hooksRouter.post("/register", async (req: AuthedRequest, res) => {
  try {
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
    }).parse(req.body ?? {});
    const userId = scopeHooks(req, params.userId);
    const hook = registerHostHook({
      userId,
      source: params.source,
      events: params.events,
      sessionKey: params.sessionKey,
      workspacePath: params.workspacePath,
      metadata: params.metadata,
    });

    if (!params.event) {
      res.status(201).json({ registered: hook });
      return;
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
      ? await processClaudeCodeHook(memoryEngine, payload, userId)
      : params.source === "codex"
        ? await processCodexHook(memoryEngine, payload, userId)
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

    res.status(201).json({ registered: hook, captureResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid hook registration body";
    res.status(errorStatus(error, 400)).json({ error: message });
  }
});

hooksRouter.get("/status", (req: AuthedRequest, res) => {
  try {
    const params = z.object({
      source: hookSourceSchema.optional(),
      userId: z.string().optional(),
    }).parse(req.query);
    const userId = scopeHooks(req, params.userId);
    const hooks = listHostHooks(userId).filter((hook) => !params.source || hook.source === params.source);
    res.json({ hooks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid hook status parameters";
    res.status(errorStatus(error, 400)).json({ error: message });
  }
});
