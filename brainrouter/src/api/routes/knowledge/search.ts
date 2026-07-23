/** Authenticated, Project-scoped REST transport for knowledge retrieval. */

import { Router, type Response } from 'express';
import { sendError } from '../../../contracts/http.js';
import { knowledgeActorFromAuth, type KnowledgeActor } from '../../../knowledge/contracts/actor.js';
import type {
  KnowledgeSearchResult,
  KnowledgeSearchServiceFailure,
  KnowledgeSearchServiceResult,
  SearchKnowledgeInput,
} from '../../../knowledge/contracts/search.js';
import { KnowledgeSearchService } from '../../../knowledge/services/search.js';
import { memoryEngine } from '../../../memory/engine.js';
import { requireAnyAuth, type AuthedRequest } from '../../middleware/auth.js';
import { withOrgContext } from '../../middleware/tenancy.js';

export interface KnowledgeSearchOperations {
  search(
    actor: KnowledgeActor,
    projectId: string,
    input: SearchKnowledgeInput,
  ): Promise<KnowledgeSearchServiceResult<KnowledgeSearchResult>>;
}

export function createKnowledgeSearchRouter(service: KnowledgeSearchOperations): Router {
  const router = Router();
  router.use(requireAnyAuth, withOrgContext);

  router.post('/projects/:projectId/search', async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.search(actor, String(req.params.projectId), {
      query: req.body?.query,
      baseIds: req.body?.baseIds,
      limit: req.body?.limit,
    });
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.json({ search: result.value });
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
  if (!actor) sendError(res, 500, 'Knowledge authorization context is unavailable');
  return actor;
}

function sendKnowledgeFailure(res: Response, failure: KnowledgeSearchServiceFailure): Response {
  switch (failure.code) {
    case 'not_found':
      return sendError(res, 404, 'Knowledge resource not found');
    case 'forbidden':
      return sendError(res, 403, 'Knowledge access is forbidden');
    case 'invalid':
      return sendError(res, 400, 'Invalid knowledge search input', { field: failure.field });
  }
}

export const knowledgeSearchRouter = createKnowledgeSearchRouter(
  new KnowledgeSearchService(memoryEngine.knowledge, {
    resolveEmbeddingProvider: (orgId) => memoryEngine.resolveKnowledgeEmbeddingProvider(orgId),
  }),
);
