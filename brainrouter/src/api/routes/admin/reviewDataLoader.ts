export type RepositoryFetchResult<Row> =
  | { status: "ok"; rows: Row[]; etag?: string }
  | { status: "not-modified"; etag?: string };

export interface ReviewPullRequestLoadInput<Row> {
  /** Must include org, user and credential boundary. Never include the token. */
  cacheKey: string;
  repos: string[];
  fetchRepo: (repo: string, etag: string | undefined, signal: AbortSignal) => Promise<RepositoryFetchResult<Row>>;
  force?: boolean;
}

export interface ReviewPullRequestLoadResult<Row> {
  rows: Row[];
  fresh: boolean;
  refreshing: boolean;
  partial: boolean;
  failedRepositories: string[];
}

interface LoaderOptions {
  concurrency?: number;
  freshMs?: number;
  staleMs?: number;
  repositoryDeadlineMs?: number;
  now?: () => number;
}

interface RepositoryCache<Row> {
  rows: Row[];
  etag?: string;
}

interface CombinedCache<Row> {
  rows: Row[];
  failedRepositories: string[];
  freshUntil: number;
  staleUntil: number;
}

/** Small dependency-free concurrency limiter so the review route does not turn
 * N connected repositories into N sequential GitHub round trips or an
 * unbounded burst. Results retain input order. */
async function mapConcurrent<Input, Output>(
  values: Input[],
  limit: number,
  worker: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (values.length === 0) return [];
  const output = new Array<Output>(values.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await worker(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return output;
}

export function createReviewPullRequestLoader<Row>(options: LoaderOptions = {}) {
  const concurrency = Math.min(Math.max(options.concurrency ?? 8, 1), 16);
  const freshMs = Math.max(options.freshMs ?? 30_000, 0);
  const staleMs = Math.max(options.staleMs ?? 5 * 60_000, freshMs);
  const repositoryDeadlineMs = Math.max(options.repositoryDeadlineMs ?? 5_000, 50);
  const now = options.now ?? Date.now;
  const combined = new Map<string, CombinedCache<Row>>();
  const repositories = new Map<string, RepositoryCache<Row>>();
  const inflight = new Map<string, Promise<ReviewPullRequestLoadResult<Row>>>();

  const refresh = (input: ReviewPullRequestLoadInput<Row>): Promise<ReviewPullRequestLoadResult<Row>> => {
    const current = inflight.get(input.cacheKey);
    if (current) return current;
    const promise = (async () => {
      const outcomes = await mapConcurrent(input.repos, concurrency, async (repo) => {
        const repositoryKey = `${input.cacheKey}\u0000${repo}`;
        const cached = repositories.get(repositoryKey);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), repositoryDeadlineMs);
        try {
          const response = await input.fetchRepo(repo, cached?.etag, controller.signal);
          if (response.status === "not-modified") {
            if (!cached) throw new Error("GitHub returned not-modified without a cached repository response");
            const next = { ...cached, etag: response.etag ?? cached.etag };
            repositories.set(repositoryKey, next);
            return { repo, rows: next.rows, failed: false };
          }
          const next = { rows: response.rows, etag: response.etag };
          repositories.set(repositoryKey, next);
          return { repo, rows: next.rows, failed: false };
        } catch {
          // Preserve usable stale rows for one failed repository, but mark the
          // envelope partial so the UI can say that refresh was incomplete.
          return { repo, rows: cached?.rows ?? [], failed: true };
        } finally {
          clearTimeout(timer);
        }
      });
      const failedRepositories = outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.repo);
      const entry: CombinedCache<Row> = {
        rows: outcomes.flatMap((outcome) => outcome.rows),
        failedRepositories,
        freshUntil: now() + freshMs,
        staleUntil: now() + staleMs,
      };
      combined.set(input.cacheKey, entry);
      return {
        rows: entry.rows,
        fresh: true,
        refreshing: false,
        partial: failedRepositories.length > 0,
        failedRepositories,
      };
    })().finally(() => {
      inflight.delete(input.cacheKey);
    });
    inflight.set(input.cacheKey, promise);
    return promise;
  };

  return {
    async load(input: ReviewPullRequestLoadInput<Row>): Promise<ReviewPullRequestLoadResult<Row>> {
      const cached = combined.get(input.cacheKey);
      const timestamp = now();
      if (!input.force && cached && cached.freshUntil >= timestamp) {
        return { rows: cached.rows, fresh: true, refreshing: false, partial: cached.failedRepositories.length > 0, failedRepositories: cached.failedRepositories };
      }
      if (!input.force && cached && cached.staleUntil >= timestamp) {
        void refresh(input).catch(() => {});
        return { rows: cached.rows, fresh: false, refreshing: true, partial: cached.failedRepositories.length > 0, failedRepositories: cached.failedRepositories };
      }
      return refresh(input);
    },
    clear(cacheKey?: string): void {
      if (!cacheKey) {
        combined.clear();
        repositories.clear();
        return;
      }
      combined.delete(cacheKey);
      for (const key of repositories.keys()) if (key.startsWith(`${cacheKey}\u0000`)) repositories.delete(key);
    },
  };
}
