import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      }, { once: true });
    }
  });
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly id = 'brave' as const;
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults, 20);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    let lastStatus = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
        signal,
      });
      if (res.ok) {
        const body = await res.json() as any;
        return (Array.isArray(body?.web?.results) ? body.web.results : [])
          .map((item: any) => normalizeResult({
            title: item?.title,
            url: item?.url,
            snippet: item?.description,
            publishedDate: item?.age,
          }))
          .filter((item: WebSearchResult | null): item is WebSearchResult => !!item)
          .slice(0, limit);
      }
      lastStatus = `${res.status} ${res.statusText}`;
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 2) break;
      await sleep(200 * (attempt + 1), signal);
    }
    throw new Error(`Brave returned ${lastStatus}`);
  }
}
