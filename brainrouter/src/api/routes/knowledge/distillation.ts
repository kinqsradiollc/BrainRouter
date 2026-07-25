import { Router, type Response } from "express";
import { sendError } from "../../../contracts/http.js";
import {
  knowledgeActorFromAuth,
  type KnowledgeActor,
} from "../../../knowledge/contracts/actor.js";
import type {
  DistillKnowledgeBaseInput,
  KnowledgeDistillationFailure,
  KnowledgeDistillationResult,
  KnowledgeDistillationServiceResult,
} from "../../../knowledge/contracts/document.js";
import { KnowledgeDistillationService } from "../../../knowledge/services/distillation.js";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { withOrgContext } from "../../middleware/tenancy.js";

const MAX_SCOPE_ID_LENGTH = 512;

export interface KnowledgeDistillationOperations {
  distill(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: DistillKnowledgeBaseInput,
  ): Promise<KnowledgeDistillationServiceResult<KnowledgeDistillationResult>>;
}

export function createKnowledgeDistillationRouter(
  service: KnowledgeDistillationOperations,
): Router {
  const router = Router();
  router.use(requireAnyAuth, withOrgContext);

  router.post("/projects/:projectId/bases/:baseId/distill", async (
    req: AuthedRequest,
    res,
  ) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const projectId = boundedRouteId(req.params.projectId);
    const baseId = boundedRouteId(req.params.baseId);
    if (!projectId || !baseId) {
      return sendError(res, 400, "Invalid knowledge resource identifier");
    }
    const result = await service.distill(
      actor,
      projectId,
      baseId,
      {
        confirmed: req.body?.confirmed,
        documentIds: req.body?.documentIds,
        maxNotes: req.body?.maxNotes,
      },
    );
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(202).json({
      distillationVersion: result.value.distillationVersion,
      sourceDocumentIds: result.value.sourceDocumentIds,
      documents: result.value.documents.map((item) => ({
        documentId: item.document.documentId,
        title: item.document.title,
        sourceFormat: item.document.sourceFormat,
        origin: item.document.origin,
        status: item.document.status,
        sourceDocumentIds: item.sourceDocumentIds,
        created: item.created,
      })),
    });
  });

  return router;
}

function actorFromRequest(req: AuthedRequest, res: Response): KnowledgeActor | null {
  const actor = knowledgeActorFromAuth({
    userId: req.userId,
    orgId: req.orgId,
    role: req.role,
    isAdmin: req.isAdmin,
  });
  if (!actor) sendError(res, 500, "Knowledge authorization context is unavailable");
  return actor;
}

function boundedRouteId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_SCOPE_ID_LENGTH ? normalized : null;
}

function sendKnowledgeFailure(
  res: Response,
  failure: KnowledgeDistillationFailure,
): Response {
  switch (failure.code) {
    case "not_found":
      return sendError(res, 404, "Knowledge resource not found");
    case "forbidden":
      return sendError(res, 403, "Knowledge write access is required");
    case "invalid":
      return sendError(res, 400, "Invalid knowledge distillation input", {
        field: failure.field,
      });
    case "unavailable":
      return sendError(res, 503, "Knowledge distillation is unavailable");
  }
}

export const knowledgeDistillationRouter = createKnowledgeDistillationRouter(
  new KnowledgeDistillationService(memoryEngine.knowledge, {
    resolveRunner: (orgId) => memoryEngine.modelRunner("knowledge-distillation", orgId),
  }),
);
