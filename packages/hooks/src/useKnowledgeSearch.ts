import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrainRouterClient,
  type KnowledgeSearchResult,
  type SearchKnowledgeInput,
} from "@kinqs/brainrouter-sdk";
import { isAbortError, useKnowledgeMutation } from "./useKnowledgeRequest.js";

interface SearchSnapshot {
  projectId: string;
  result: KnowledgeSearchResult | null;
}

export function useKnowledgeSearch(client: BrainRouterClient, projectId: string) {
  const [snapshot, setSnapshot] = useState<SearchSnapshot>({ projectId, result: null });
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const {
    run,
    error,
    isMutating: isSearching,
  } = useKnowledgeMutation(projectId, true);

  useEffect(() => {
    setSnapshot({ projectId, result: null });
  }, [projectId]);

  const search = useCallback(async (input: SearchKnowledgeInput) => {
    try {
      const response = await run((signal) =>
        client.searchKnowledge(projectId, input, { signal }));
      if (projectIdRef.current === projectId) {
        setSnapshot({ projectId, result: response.search });
      }
      return response.search;
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }, [client, projectId, run]);

  const clear = useCallback(() => {
    setSnapshot({ projectId: projectIdRef.current, result: null });
  }, []);

  return {
    result: snapshot.projectId === projectId ? snapshot.result : null,
    error,
    isSearching,
    search,
    clear,
  };
}
