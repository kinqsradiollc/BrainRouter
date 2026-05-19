import { useCallback } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import { useCursorPagination } from "./useCursorPagination.js";

export function useScenes(client: BrainRouterClient) {
  const fetchScenes = useCallback((params?: { cursor?: string }) => {
    return client.getScenes(params);
  }, [client]);

  const { items: scenes, ...pagination } = useCursorPagination("scenes", fetchScenes);

  return { scenes, ...pagination };
}
