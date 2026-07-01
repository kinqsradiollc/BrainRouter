import { useCallback } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { ContradictionRecord } from "@kinqs/brainrouter-types";
import { useCursorPagination } from "./useCursorPagination.js";

export function useContradictions(
  client: BrainRouterClient,
  status: "pending" | "resolved" | "dismissed" | "all" = "pending",
) {
  const fetchContradictions = useCallback((params?: { cursor?: string }) => {
    return client.getContradictions({ ...params, status });
  }, [client, status]);

  const { items: contradictions, ...pagination } = useCursorPagination<ContradictionRecord, "contradictions">("contradictions", fetchContradictions);

  return { contradictions, ...pagination };
}
