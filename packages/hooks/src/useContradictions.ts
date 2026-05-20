import { useCallback } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import type { ContradictionRecord } from "@brainrouter/types";
import { useCursorPagination } from "./useCursorPagination.js";

export function useContradictions(client: BrainRouterClient) {
  const fetchContradictions = useCallback((params?: { cursor?: string }) => {
    return client.getContradictions(params);
  }, [client]);

  const { items: contradictions, ...pagination } = useCursorPagination<ContradictionRecord, "contradictions">("contradictions", fetchContradictions);

  return { contradictions, ...pagination };
}
