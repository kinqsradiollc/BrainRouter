import { useCallback } from "react";
import {
  BrainRouterClient,
  type CreateKnowledgeBaseInput,
  type KnowledgeBase,
  type UpdateKnowledgeBaseInput,
} from "@kinqs/brainrouter-sdk";
import { useKnowledgeMutation, useKnowledgeQuery } from "./useKnowledgeRequest.js";

const EMPTY_BASES: KnowledgeBase[] = [];

export function useKnowledgeBases(client: BrainRouterClient, projectId: string) {
  const scopeKey = projectId;
  const load = useCallback(
    (signal: AbortSignal) =>
      client.listKnowledgeBases(projectId, { signal }).then((response) => response.bases),
    [client, projectId],
  );
  const {
    value: bases,
    error: queryError,
    isLoading,
    reload,
  } = useKnowledgeQuery(scopeKey, Boolean(projectId), EMPTY_BASES, load);
  const {
    run,
    error: mutationError,
    isMutating,
  } = useKnowledgeMutation(scopeKey);

  const createBase = useCallback(async (input: CreateKnowledgeBaseInput) => {
    const response = await run((signal) =>
      client.createKnowledgeBase(projectId, input, { signal }));
    reload();
    return response.base;
  }, [client, projectId, reload, run]);

  const updateBase = useCallback(async (baseId: string, input: UpdateKnowledgeBaseInput) => {
    const response = await run((signal) =>
      client.updateKnowledgeBase(projectId, baseId, input, { signal }));
    reload();
    return response.base;
  }, [client, projectId, reload, run]);

  const deleteBase = useCallback(async (baseId: string) => {
    await run((signal) =>
      client.deleteKnowledgeBase(projectId, baseId, { signal }));
    reload();
  }, [client, projectId, reload, run]);

  return {
    bases,
    error: mutationError ?? queryError,
    isLoading,
    isMutating,
    reload,
    createBase,
    updateBase,
    deleteBase,
  };
}
