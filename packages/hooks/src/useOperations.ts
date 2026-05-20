import { useCallback, useEffect, useState } from "react";
import { BrainRouterClient } from "@brainrouter/sdk";
import type { MemoryOperation, OperationsResponse } from "@brainrouter/types";

export interface OperationFilters {
  userId?: string;
  operation?: string;
  sessionKey?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
}

export function useOperations(client: BrainRouterClient, filters: OperationFilters = {}) {
  const [operations, setOperations] = useState<MemoryOperation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtersKey = JSON.stringify(filters);

  const applyPage = useCallback((page: OperationsResponse, mode: "replace" | "append") => {
    setOperations((current) => mode === "append" ? [...current, ...page.operations] : page.operations);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const activeFilters = JSON.parse(filtersKey) as OperationFilters;
      applyPage(await client.getOperations(activeFilters), "replace");
    } catch (e) {
      setError(String(e));
      setOperations([]);
      setNextCursor(null);
      setHasMore(false);
    } finally {
      setIsLoading(false);
    }
  }, [applyPage, client, filtersKey]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isFetchingMore) return;
    setIsFetchingMore(true);
    setError(null);
    try {
      const activeFilters = JSON.parse(filtersKey) as OperationFilters;
      applyPage(await client.getOperations({ ...activeFilters, cursor: nextCursor }), "append");
    } catch (e) {
      setError(String(e));
    } finally {
      setIsFetchingMore(false);
    }
  }, [applyPage, client, filtersKey, isFetchingMore, nextCursor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { operations, error, refresh, loadMore, nextCursor, hasMore, isLoading, isFetchingMore };
}
