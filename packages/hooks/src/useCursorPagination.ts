import { useCallback, useEffect, useState } from "react";

interface CursorPage<T> {
  nextCursor: string | null;
  hasMore: boolean;
  [key: string]: unknown;
}

export function useCursorPagination<T, K extends string>(
  key: K,
  fetchPage: (params?: { cursor?: string }) => Promise<CursorPage<T> & Record<K, T[]>>
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPage = useCallback((page: CursorPage<T> & Record<K, T[]>, mode: "replace" | "append") => {
    setItems((current) => (mode === "append" ? [...current, ...page[key]] : page[key]));
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }, [key]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      applyPage(await fetchPage(), "replace");
    } catch (e) {
      setError(String(e));
    } finally {
      setIsLoading(false);
    }
  }, [applyPage, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isFetchingMore) return;
    setIsFetchingMore(true);
    setError(null);
    try {
      applyPage(await fetchPage({ cursor: nextCursor }), "append");
    } catch (e) {
      setError(String(e));
    } finally {
      setIsFetchingMore(false);
    }
  }, [applyPage, fetchPage, isFetchingMore, nextCursor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { items, error, refresh, loadMore, nextCursor, hasMore, isLoading, isFetchingMore };
}
