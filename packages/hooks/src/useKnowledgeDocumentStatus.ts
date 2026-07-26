import { useCallback } from "react";
import {
  BrainRouterClient,
  type KnowledgeDocumentStatusView,
} from "@kinqs/brainrouter-sdk";
import { useKnowledgeMutation, useKnowledgeQuery } from "./useKnowledgeRequest.js";

const EMPTY_STATUS: KnowledgeDocumentStatusView | null = null;

export function useKnowledgeDocumentStatus(
  client: BrainRouterClient,
  projectId: string,
  baseId: string,
  documentId: string,
) {
  const scopeKey = JSON.stringify([projectId, baseId, documentId]);
  const load = useCallback(
    (signal: AbortSignal) =>
      client.getKnowledgeDocumentStatus(projectId, baseId, documentId, { signal })
        .then((response) => response.document),
    [baseId, client, documentId, projectId],
  );
  const {
    value: document,
    error: queryError,
    isLoading,
    reload,
  } = useKnowledgeQuery(
    scopeKey,
    Boolean(projectId && baseId && documentId),
    EMPTY_STATUS,
    load,
  );
  const {
    run,
    error: mutationError,
    isMutating: isRetrying,
  } = useKnowledgeMutation(scopeKey);

  const retry = useCallback(async () => {
    const response = await run((signal) =>
      client.retryKnowledgeDocument(projectId, baseId, documentId, { signal }));
    reload();
    return response.retry;
  }, [baseId, client, documentId, projectId, reload, run]);

  return {
    document,
    error: mutationError ?? queryError,
    isLoading,
    isRetrying,
    reload,
    retry,
  };
}
