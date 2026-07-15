interface QueryEntry {
  value?: unknown;
  updatedAt: number;
  inflight?: Promise<unknown>;
}

const queries = new Map<string, QueryEntry>();

export interface DashboardQueryOptions {
  ttlMs?: number;
  force?: boolean;
  now?: () => number;
}

/** Small authenticated SWR cache for high-traffic dashboard GETs. Stale values
 * paint immediately while a single deduplicated refresh runs in the background. */
export function queryDashboard<T>(key: string, fetcher: () => Promise<T>, options: DashboardQueryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 30_000;
  const entry = queries.get(key) ?? { updatedAt: 0 };
  queries.set(key, entry);

  const refresh = (): Promise<T> => {
    if (entry.inflight) return entry.inflight as Promise<T>;
    const request = fetcher().then((value) => {
      entry.value = value;
      entry.updatedAt = now();
      return value;
    }).finally(() => {
      if (entry.inflight === request) entry.inflight = undefined;
    });
    entry.inflight = request;
    return request;
  };

  if (!options.force && entry.value !== undefined) {
    if (now() - entry.updatedAt >= ttlMs) void refresh().catch(() => {});
    return Promise.resolve(entry.value as T);
  }
  return refresh();
}

export function invalidateDashboardQueries(prefix: string): void {
  for (const key of queries.keys()) if (key.startsWith(prefix)) queries.delete(key);
}

export function clearDashboardQueries(): void {
  queries.clear();
}
