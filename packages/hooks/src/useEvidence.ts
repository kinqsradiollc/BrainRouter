import { useCallback, useEffect, useState } from "react";
import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { EvidenceKind, EvidenceResponse, MemoryEvidence } from "@kinqs/brainrouter-types";

export interface EvidenceFilters {
  userId?: string;
  recordId?: string;
  kind?: EvidenceKind | "all";
  limit?: number;
}

export function useEvidence(client: BrainRouterClient, filters: EvidenceFilters = {}) {
  const [evidence, setEvidence] = useState<MemoryEvidence[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filtersKey = JSON.stringify(filters);

  function parseFilters(): EvidenceFilters {
    const activeFilters = JSON.parse(filtersKey) as EvidenceFilters;
    return {
      ...activeFilters,
      kind: activeFilters.kind && activeFilters.kind !== "all" ? activeFilters.kind : undefined,
    };
  }

  const applyPage = useCallback((page: EvidenceResponse, mode: "replace" | "append") => {
    setEvidence((current) => mode === "append" ? [...current, ...page.evidence] : page.evidence);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      applyPage(await client.getEvidence(parseFilters()), "replace");
    } catch (e) {
      setError(String(e));
      setEvidence([]);
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
      applyPage(await client.getEvidence({ ...parseFilters(), cursor: nextCursor }), "append");
    } catch (e) {
      setError(String(e));
    } finally {
      setIsFetchingMore(false);
    }
  }, [applyPage, client, filtersKey, isFetchingMore, nextCursor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { evidence, error, refresh, loadMore, nextCursor, hasMore, isLoading, isFetchingMore };
}
