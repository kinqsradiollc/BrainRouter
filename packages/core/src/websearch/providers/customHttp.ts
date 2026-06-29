import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

export class CustomHttpSearchProvider implements WebSearchProvider {
  readonly id = 'custom_http' as const;
  constructor(private readonly endpoint: string, private readonly fallback?: WebSearchProvider) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, maxResults: limit }),
        signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json() as any;
      const raw = Array.isArray(body?.results) ? body.results : [];
      const results = raw
        .map((item: any) => normalizeResult({
          title: item?.title,
          url: item?.url ?? item?.link,
          snippet: item?.snippet ?? item?.description,
          author: item?.author,
          publishedDate: item?.publishedDate ?? item?.date,
        }))
        .filter((item: WebSearchResult | null): item is WebSearchResult => !!item)
        .slice(0, limit);
      if (results.length > 0 || !this.fallback) return results;
    } catch {
      if (!this.fallback) throw new Error(`Custom web search endpoint failed: ${this.endpoint}`);
    }
    return this.fallback.search(query, limit, signal);
  }
}
