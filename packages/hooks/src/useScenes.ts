import { useCallback } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { ContextualFocusRecord } from "@kinqs/brainrouter-types";
import { useCursorPagination } from "./useCursorPagination.js";

export function useScenes(client: BrainRouterClient) {
  const fetchScenes = useCallback((params?: { cursor?: string }) => {
    return client.getScenes(params);
  }, [client]);

  const { items: scenes, refresh, ...pagination } = useCursorPagination<ContextualFocusRecord, "scenes">("scenes", fetchScenes);

  const evictScene = useCallback(async (id: string) => {
    await client.deleteScene(id);
    await refresh();
  }, [client, refresh]);

  return { scenes, refresh, evictScene, ...pagination };
}
