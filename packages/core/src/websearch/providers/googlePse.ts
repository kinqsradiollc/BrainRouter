import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

function metaValue(item: any, names: string[]): string | undefined {
  const tags = Array.isArray(item?.pagemap?.metatags) ? item.pagemap.metatags : [];
  for (const tag of tags) {
    for (const name of names) {
      const value = tag?.[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

export class GooglePseSearchProvider implements WebSearchProvider {
  readonly id = 'google_pse' as const;
  constructor(private readonly apiKey: string, private readonly cx: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults, 10);
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('cx', this.cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Google PSE returned ${res.status} ${res.statusText}`);
    const body = await res.json() as any;
    return (Array.isArray(body?.items) ? body.items : [])
      .map((item: any) => normalizeResult({
        title: item?.title,
        url: item?.link,
        snippet: item?.snippet,
        author: metaValue(item, ['author', 'article:author']),
        publishedDate: metaValue(item, ['article:published_time', 'datePublished', 'pubdate', 'date']),
      }))
      .filter((item: WebSearchResult | null): item is WebSearchResult => !!item)
      .slice(0, limit);
  }
}
