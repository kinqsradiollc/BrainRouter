import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = 'searxng' as const;
  constructor(private readonly baseUrl: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults, 50);
    const url = new URL('/search?format=json', this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    const body = new URLSearchParams({ q: query });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal,
    });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    return (Array.isArray(data?.results) ? data.results : [])
      .map((item: any) => normalizeResult({
        title: item?.title,
        url: item?.url,
        snippet: item?.content ?? item?.snippet,
        publishedDate: item?.publishedDate,
      }))
      .filter((item: WebSearchResult | null): item is WebSearchResult => !!item)
      .slice(0, limit);
  }
}
