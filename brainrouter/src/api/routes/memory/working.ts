import { Router } from "express";
import { z } from "zod";

import {
  getWorkingContext,
  offloadWorkingPayload,
  resetWorkingMemory,
  listActiveSessions,
} from "../../../memory/working/offload.js";
import { requireAnyAuth, scopedUserId, errorStatus, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";

export const workingRouter = Router();
workingRouter.use(requireAnyAuth);

const optionalPositiveInt = z.coerce.number().int().positive().optional();
const optionalNonnegativeInt = z.coerce.number().int().nonnegative().optional();

const scopeWorking = (req: AuthedRequest, requested?: unknown) => scopedUserId(req, requested, "working memory");

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
    const userId = scopeWorking(req, params.userId);

    res.json(getWorkingContext(params.workspacePath, userId, params.sessionKey, {
      nodeId: params.nodeId,
      activeNodeId: params.activeNodeId,
      contextWindowTokens: params.contextWindowTokens,
      estimatedTokens: params.estimatedTokens,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working context parameters";
    sendError(res, errorStatus(error, 400), message);
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
    const userId = scopeWorking(req, params.userId);

    res.status(201).json(offloadWorkingPayload({ ...params, userId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working offload body";
    sendError(res, errorStatus(error, 400), message);
  }
});

workingRouter.post("/reset", (req: AuthedRequest, res) => {
  try {
    const params = z.object({
      workspacePath: z.string().optional(),
      userId: z.string().optional(),
      sessionKey: z.string().min(1),
    }).parse(req.body ?? {});
    const userId = scopeWorking(req, params.userId);

    res.json(resetWorkingMemory(params.workspacePath, userId, params.sessionKey));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid working reset body";
    sendError(res, errorStatus(error, 400), message);
  }
});

workingRouter.get("/sessions", (req: AuthedRequest, res) => {
  try {
    const userId = scopeWorking(req, req.query.userId);
    const sessions = listActiveSessions(userId);
    res.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list active sessions";
    sendError(res, errorStatus(error, 400), message);
  }
});
