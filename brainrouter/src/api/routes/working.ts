import { Router } from "express";
import { z } from "zod";

import {
  getWorkingContext,
  offloadWorkingPayload,
  resetWorkingMemory,
  listActiveSessions,
} from "../../memory/working/offload.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const workingRouter = Router();
workingRouter.use(requireAnyAuth);

const optionalPositiveInt = z.coerce.number().int().positive().optional();
const optionalNonnegativeInt = z.coerce.number().int().nonnegative().optional();

function scopedUserId(req: AuthedRequest, requested?: unknown): string {
  const requestedUserId = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
  if (!requestedUserId || requestedUserId === req.userId) return req.userId!;
  if (req.isAdmin) return requestedUserId;
  throw new Error("Cannot access another user's working memory");
}

workingRouter.get("/context", (req: AuthedRequest, res) => {
  try {
    const params = z.object({
      workspacePath: z.string().optional(),
      userId: z.string().optional(),
      sessionKey: z.string().min(1),
      nodeId: z.string().optional(),
      activeNodeId: z.string().optional(),
      contextWindowTokens: optionalPositiveInt,
      estimatedTokens: optionalNonnegativeInt,
    }).parse(req.query);
    const userId = scopedUserId(req, params.userId);

    res.json(getWorkingContext(params.workspacePath, userId, params.sessionKey, {
      nodeId: params.nodeId,
      activeNodeId: params.activeNodeId,
      contextWindowTokens: params.contextWindowTokens,
      estimatedTokens: params.estimatedTokens,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working context parameters";
    res.status(message.includes("another user") ? 403 : 400).json({ error: message });
  }
});

workingRouter.post("/offload", (req: AuthedRequest, res) => {
  try {
    const params = z.object({
      workspacePath: z.string().optional(),
      userId: z.string().optional(),
      sessionKey: z.string().min(1),
      payload: z.string().min(1),
      title: z.string().optional(),
      summary: z.string().optional(),
      kind: z.string().optional(),
      contextWindowTokens: z.number().int().positive().optional(),
      estimatedTokens: z.number().int().nonnegative().optional(),
      forceAggressive: z.boolean().optional(),
    }).parse(req.body ?? {});
    const userId = scopedUserId(req, params.userId);

    res.status(201).json(offloadWorkingPayload({ ...params, userId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working offload body";
    res.status(message.includes("another user") ? 403 : 400).json({ error: message });
  }
});

workingRouter.post("/reset", (req: AuthedRequest, res) => {
  try {
    const params = z.object({
      workspacePath: z.string().optional(),
      userId: z.string().optional(),
      sessionKey: z.string().min(1),
    }).parse(req.body ?? {});
    const userId = scopedUserId(req, params.userId);

    res.json(resetWorkingMemory(params.workspacePath, userId, params.sessionKey));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working reset body";
    res.status(message.includes("another user") ? 403 : 400).json({ error: message });
  }
});

workingRouter.get("/sessions", (req: AuthedRequest, res) => {
  try {
    const userId = scopedUserId(req, req.query.userId);
    const sessions = listActiveSessions(userId);
    res.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list active sessions";
    res.status(message.includes("another user") ? 403 : 400).json({ error: message });
  }
});
