import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = 'duckduckgo' as const;

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults);
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { 'User-Agent': 'BrainRouterCrawler/0.4.16' }, signal });
    if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    const results: WebSearchResult[] = [];
    const abstract = normalizeResult({ title: data?.Heading ?? query, url: data?.AbstractURL, snippet: data?.AbstractText });
    if (abstract) results.push(abstract);
    const topics = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
    for (const topic of topics) {
      if (results.length >= limit) break;
      if (topic?.FirstURL && topic?.Text) {
        const item = normalizeResult({ title: String(topic.Text).split(' - ')[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text });
        if (item) results.push(item);
      } else if (Array.isArray(topic?.Topics)) {
        for (const inner of topic.Topics) {
          if (results.length >= limit) break;
          const item = normalizeResult({ title: String(inner?.Text ?? '').split(' - ')[0], url: inner?.FirstURL, snippet: inner?.Text });
          if (item) results.push(item);
        }
      }
    }
    return results.slice(0, limit);
  }
}
