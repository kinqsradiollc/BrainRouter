import { useCallback } from "react";
import {
  BrainRouterClient,
  type IngestKnowledgeBinaryInput,
  type IngestKnowledgeTextInput,
  type KnowledgeDocumentSummary,
  type ListKnowledgeDocumentsInput,
} from "@kinqs/brainrouter-sdk";
import { useKnowledgeMutation, useKnowledgeQuery } from "./useKnowledgeRequest.js";

const EMPTY_DOCUMENTS: KnowledgeDocumentSummary[] = [];

export function useKnowledgeDocuments(
  client: BrainRouterClient,
  projectId: string,
  baseId: string,
  filters: ListKnowledgeDocumentsInput = {},
) {
  const { status, origin, limit } = filters;
  const scopeKey = JSON.stringify([projectId, baseId, status ?? "", origin ?? "", limit ?? ""]);
  const load = useCallback(
    (signal: AbortSignal) =>
      client.listKnowledgeDocuments(
        projectId,
        baseId,
        { status, origin, limit },
        { signal },
      ).then((response) => response.documents),
    [baseId, client, limit, origin, projectId, status],
  );
  const {
    value: documents,
    error: queryError,
    isLoading,
    reload,
  } = useKnowledgeQuery(
    scopeKey,
    Boolean(projectId && baseId),
    EMPTY_DOCUMENTS,
    load,
  );
  const {
    run,
    error: mutationError,
    isMutating,
  } = useKnowledgeMutation(scopeKey);

  const ingestText = useCallback(async (input: IngestKnowledgeTextInput) => {
    const response = await run((signal) =>
      client.ingestKnowledgeText(projectId, baseId, input, { signal }));
    reload();
    return response;
  }, [baseId, client, projectId, reload, run]);

  const ingestPdf = useCallback(async (input: IngestKnowledgeBinaryInput) => {
    const response = await run((signal) =>
      client.ingestKnowledgePdf(projectId, baseId, input, { signal }));
    reload();
    return response;
  }, [baseId, client, projectId, reload, run]);

  const ingestDocx = useCallback(async (input: IngestKnowledgeBinaryInput) => {
    const response = await run((signal) =>
      client.ingestKnowledgeDocx(projectId, baseId, input, { signal }));
    reload();
    return response;
  }, [baseId, client, projectId, reload, run]);

  return {
    documents,
    error: mutationError ?? queryError,
    isLoading,
    isMutating,
    reload,
    ingestText,
    ingestPdf,
    ingestDocx,
  };
}
