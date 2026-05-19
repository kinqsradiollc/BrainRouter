import { useCallback } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import { useCursorPagination } from "./useCursorPagination.js";

export function useMemories(client: BrainRouterClient) {
  const fetchMemories = useCallback((params?: { cursor?: string }) => {
    return client.getMemories(params);
  }, [client]);

  const { items: memories, ...pagination } = useCursorPagination("memories", fetchMemories);

  return { memories, ...pagination };
}
