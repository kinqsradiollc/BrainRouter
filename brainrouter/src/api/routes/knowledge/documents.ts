/**
 * Authenticated, Project-scoped REST transport for asynchronous knowledge
 * document ingestion, processing status, and retry.
 */

import { Router, type Response } from 'express';
import { sendError } from '../../../contracts/http.js';
import { knowledgeActorFromAuth, type KnowledgeActor } from '../../../knowledge/contracts/actor.js';
import type {
  IngestKnowledgePdfInput,
  IngestKnowledgeTextInput,
  KnowledgeDocumentEnqueueResult,
  KnowledgeDocumentRecord,
  KnowledgeDocumentRetryView,
  KnowledgeDocumentServiceFailure,
  KnowledgeDocumentServiceResult,
  KnowledgeDocumentStatusView,
} from '../../../knowledge/contracts/document.js';
import { KnowledgeDocumentService } from '../../../knowledge/services/documents.js';
import { memoryEngine } from '../../../memory/engine.js';
import { requireAnyAuth, type AuthedRequest } from '../../middleware/auth.js';
import { withOrgContext } from '../../middleware/tenancy.js';

export interface KnowledgeDocumentOperations {
  ingestText(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgeTextInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>>;
  ingestPdf(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    input: IngestKnowledgePdfInput,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentEnqueueResult>>;
  status(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentStatusView>>;
  retry(
    actor: KnowledgeActor,
    projectId: string,
    baseId: string,
    documentId: string,
  ): Promise<KnowledgeDocumentServiceResult<KnowledgeDocumentRetryView>>;
}

export function createKnowledgeDocumentsRouter(service: KnowledgeDocumentOperations): Router {
  const router = Router();
  router.use(requireAnyAuth, withOrgContext);

  router.post('/projects/:projectId/bases/:baseId/documents/text', async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.ingestText(actor, String(req.params.projectId), String(req.params.baseId), {
      title: req.body?.title,
      sourceName: req.body?.sourceName,
      sourceFormat: req.body?.sourceFormat,
      content: req.body?.content,
    });
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(202).json({
      document: toKnowledgeDocumentView(result.value.document),
      created: result.value.created,
    });
  });

  router.post('/projects/:projectId/bases/:baseId/documents/pdf', async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.ingestPdf(actor, String(req.params.projectId), String(req.params.baseId), {
      title: req.body?.title,
      sourceName: req.body?.sourceName,
      contentBase64: req.body?.contentBase64,
    });
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(202).json({
      document: toKnowledgeDocumentView(result.value.document),
      created: result.value.created,
    });
  });

  router.get('/projects/:projectId/bases/:baseId/documents/:documentId/status', async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.status(
      actor,
      String(req.params.projectId),
      String(req.params.baseId),
      String(req.params.documentId),
    );
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.json({ document: result.value });
  });

  router.post('/projects/:projectId/bases/:baseId/documents/:documentId/retry', async (req: AuthedRequest, res) => {
    const actor = actorFromRequest(req, res);
    if (!actor) return;
    const result = await service.retry(
      actor,
      String(req.params.projectId),
      String(req.params.baseId),
      String(req.params.documentId),
    );
    if (!result.ok) return sendKnowledgeFailure(res, result);
    res.status(202).json({ retry: result.value });
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

function sendKnowledgeFailure(res: Response, failure: KnowledgeDocumentServiceFailure): Response {
  switch (failure.code) {
    case 'not_found':
      return sendError(res, 404, 'Knowledge resource not found');
    case 'forbidden':
      return sendError(res, 403, 'Knowledge access is forbidden');
    case 'invalid':
      return sendError(res, 400, 'Invalid knowledge document input', { field: failure.field });
  }
}

function toKnowledgeDocumentView(record: KnowledgeDocumentRecord) {
  return {
    documentId: record.documentId,
    title: record.title,
    sourceName: record.sourceName,
    sourceFormat: record.sourceFormat,
    status: record.status,
    statusMessage: record.statusMessage,
    parseVersion: record.parseVersion,
    updatedAt: record.updatedAt,
    readyAt: record.readyAt,
  };
}

export const knowledgeDocumentsRouter = createKnowledgeDocumentsRouter(
  new KnowledgeDocumentService(memoryEngine.knowledge),
);
