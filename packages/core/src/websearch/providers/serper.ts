import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

export class SerperSearchProvider implements WebSearchProvider {
  readonly id = 'serper' as const;
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults, 10);
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.apiKey },
      body: JSON.stringify({ q: query, num: limit }),
      signal,
    });
    if (!res.ok) throw new Error(`Serper returned ${res.status} ${res.statusText}`);
    const body = await res.json() as any;
    return (Array.isArray(body?.organic) ? body.organic : [])
      .map((item: any) => normalizeResult({
        title: item?.title,
        url: item?.link,
        snippet: item?.snippet,
        publishedDate: item?.date,
      }))
      .filter((item: WebSearchResult | null): item is WebSearchResult => !!item)
      .slice(0, limit);
  }
}
