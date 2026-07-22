import { Router, type Response } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { sendError } from "../../../contracts/http.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { withOrgContext } from "../../middleware/tenancy.js";
import {
  knowledgeActorFromAuth,
  type KnowledgeActor,
} from "../../../knowledge/contracts/actor.js";
import type {
  CreateKnowledgeBaseInput,
  KnowledgeBaseRecord,
  KnowledgeServiceFailure,
  KnowledgeServiceResult,
  UpdateKnowledgeBaseInput,
} from "../../../knowledge/contracts/base.js";
import { KnowledgeBaseService } from "../../../knowledge/services/bases.js";

export interface KnowledgeBaseOperations {
  list(actor: KnowledgeActor, projectId: string): Promise<KnowledgeServiceResult<KnowledgeBaseRecord[]>>;
  get(actor: KnowledgeActor, projectId: string, baseId: string): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>>;
  create(
    actor: KnowledgeActor,
    projectId: string,
    input: CreateKnowledgeBaseInput,
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>>;
  update(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    patch: UpdateKnowledgeBaseInput,
  ): Promise<KnowledgeServiceResult<KnowledgeBaseRecord>>;
  delete(actor: KnowledgeActor, projectId: string, baseId: string): Promise<KnowledgeServiceResult<true>>;
}

/**
 * Authenticated knowledge-base REST adapter. Organization, user, role, and
 * system-admin status are derived from trusted middleware only; payload fields
 * with those names are ignored rather than forwarded to the domain service.
 */
export function createKnowledgeBasesRouter(service: KnowledgeBaseOperations): Router {
  const router = Router();
  router.use(requireAnyAuth, withOrgContext);

  router.get("/projects/:projectId/bases", async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.list(actor, String(req.params.projectId));
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.json({ bases: result.value.map(toKnowledgeBaseView) });
  });

  router.post("/projects/:projectId/bases", async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.create(actor, String(req.params.projectId), {
      name: req.body?.name,
      description: req.body?.description,
    });
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(201).json({ base: toKnowledgeBaseView(result.value) });
  });

  router.get("/projects/:projectId/bases/:baseId", async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.get(actor, String(req.params.projectId), String(req.params.baseId));
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.json({ base: toKnowledgeBaseView(result.value) });
  });

  router.patch("/projects/:projectId/bases/:baseId", async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.update(actor, String(req.params.projectId), String(req.params.baseId), {
      name: req.body?.name,
      description: req.body?.description,
    });
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.json({ base: toKnowledgeBaseView(result.value) });
  });

  router.delete("/projects/:projectId/bases/:baseId", async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.delete(actor, String(req.params.projectId), String(req.params.baseId));
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(204).end();
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

function sendKnowledgeFailure(res: Response, failure: KnowledgeServiceFailure): Response {
  switch (failure.code) {
    case "not_found":
      return sendError(res, 404, "Knowledge resource not found");
    case "forbidden":
      return sendError(res, 403, "Knowledge write access is required");
    case "invalid":
      return sendError(res, 400, "Invalid knowledge base input", { field: failure.field });
    case "conflict":
      return sendError(res, 409, "A knowledge base with this name already exists", { field: failure.field });
  }
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

export const knowledgeBasesRouter = createKnowledgeBasesRouter(
  new KnowledgeBaseService(memoryEngine.knowledge),
);
