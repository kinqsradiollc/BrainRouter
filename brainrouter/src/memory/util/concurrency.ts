// ASYNC-1 (0.4.14) — bounded-concurrency map. Bulk embedding (the import / sweep
// re-embed loop) used to `await` one record at a time, so the shared LLM
// concurrency semaphore (BRAINROUTER_LLM_MAX_CONCURRENT) never got to run more
// than one embed at once. Run the work through a fixed-size worker pool instead;
// the embeds themselves are still bounded by that semaphore inside `embed()`, so
// this saturates the cap rather than exceeding it.

/**
 * Run `fn` over `items` with at most `limit` promises in flight at a time.
 * Results are returned in input order; a slow item doesn't hold back others.
 * `next++` is safe — JS is single-threaded, so increments don't interleave.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;
  const cap = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

/**
 * Worker-pool size for bulk embedding AND the cap of the dedicated embedding
 * semaphore (0.4.15). `embed()` takes a slot from the EMBEDDING pool — separate
 * from the generative `BRAINROUTER_LLM_MAX_CONCURRENT` — so embeddings are no
 * longer throttled to the generative cap. Raise this to embed faster; lower it
 * if the embedder shares a single GPU with the generative model.
 */
export function readEmbedConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const def = 8;
  const raw = env.BRAINROUTER_EMBED_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : def;
}
