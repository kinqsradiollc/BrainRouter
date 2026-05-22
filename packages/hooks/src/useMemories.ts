import { useCallback } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { MemoryListItem } from "@kinqs/brainrouter-types";
import { useCursorPagination } from "./useCursorPagination.js";

export function useMemories(client: BrainRouterClient) {
  const fetchMemories = useCallback((params?: { cursor?: string }) => {
    return client.getMemories(params);
  }, [client]);

  const { items: memories, ...pagination } = useCursorPagination<MemoryListItem, "memories">("memories", fetchMemories);

  return { memories, ...pagination };
}
