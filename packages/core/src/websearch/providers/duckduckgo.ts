import { load } from 'cheerio';
import { clampMaxResults, normalizeResult, type WebSearchProvider, type WebSearchResult } from '../types.js';

/**
 * DuckDuckGo web search (no API key). This scrapes the real results pages
 * (html.duckduckgo.com/html, with lite.duckduckgo.com/lite as a fallback) so
 * web_search returns CURRENT ranked links + snippets.
 *
 * NB: the previous implementation hit `api.duckduckgo.com` — the DuckDuckGo
 * *Instant Answer* API, which only returns Wikipedia-style entity abstracts and
 * disambiguation topics, NOT general web results. For any time-sensitive /
 * news / current-events query it returned nothing, starving the whole research
 * chain (web_search → research_note → research_brief) of real sources. Scraping
 * the SERP is best-effort (subject to rate limits / bot challenges); a keyed
 * provider (serper / brave / google_pse / searxng) is more reliable at scale.
 */

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** DuckDuckGo wraps result hrefs in a redirect carrying the real URL in `uddg`. */
export function unwrapDuckDuckGoUrl(href: string): string {
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return href;
  }
}

/** Ads (duckduckgo.com/y.js?ad_domain=…) and internal help/disclosure links stay
 *  on the duckduckgo.com host after unwrapping — never real organic results. */
function isAdOrInternal(url: string): boolean {
  try {
    return /(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** Parse the html.duckduckgo.com/html SERP (rich result blocks with snippets). */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const $ = load(html);
  const out: WebSearchResult[] = [];
  $('.result, .web-result').each((_index, el) => {
    if (out.length >= limit) return false;
    const anchor = $(el).find('a.result__a').first();
    const href = anchor.attr('href') || '';
    const title = anchor.text().trim();
    if (!href || !title) return undefined;
    const finalUrl = unwrapDuckDuckGoUrl(href);
    if (isAdOrInternal(finalUrl)) return undefined;
    const snippet = $(el).find('.result__snippet').first().text().trim();
    const item = normalizeResult({ title, url: finalUrl, snippet });
    if (item) out.push(item);
    return undefined;
  });
  return out.slice(0, limit);
}

/** Parse the lite.duckduckgo.com/lite SERP (tabular, more tolerant fallback). */
export function parseDuckDuckGoLite(html: string, limit: number): WebSearchResult[] {
  const $ = load(html);
  const out: WebSearchResult[] = [];
  $('a.result-link').each((_index, a) => {
    if (out.length >= limit) return false;
    const href = $(a).attr('href') || '';
    const title = $(a).text().trim();
    if (!href || !title) return undefined;
    const finalUrl = unwrapDuckDuckGoUrl(href);
    if (isAdOrInternal(finalUrl)) return undefined;
    const snippet = $(a).closest('tr').nextAll('tr').first().find('.result-snippet').text().trim();
    const item = normalizeResult({ title, url: finalUrl, snippet });
    if (item) out.push(item);
    return undefined;
  });
  return out.slice(0, limit);
}

export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = 'duckduckgo' as const;

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const limit = clampMaxResults(maxResults);
    const headers = { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' };
    // Primary: the lite endpoint — simplest markup and, in practice, the most
    // reliable (html.duckduckgo.com frequently answers a 202 bot-challenge).
    try {
      const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { headers, signal });
      if (res.ok) {
        const results = parseDuckDuckGoLite(await res.text(), limit);
        if (results.length) return results;
      }
    } catch {
      /* fall through to the html endpoint */
    }
    // Fallback: the html SERP endpoint (richer snippets when it isn't challenged).
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers, signal });
    if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status} ${res.statusText}`);
    return parseDuckDuckGoHtml(await res.text(), limit);
  }
}
