import { useCallback } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import type { PublicUserRecord } from "@brainrouter/types";
import { useCursorPagination } from "./useCursorPagination.js";

export function useUsers(client: BrainRouterClient) {
  const fetchUsers = useCallback((params?: { cursor?: string }) => {
    return client.getUsers(params);
  }, [client]);

  const { items: users, ...pagination } = useCursorPagination<PublicUserRecord, "users">("users", fetchUsers);

  return { users, ...pagination };
}
