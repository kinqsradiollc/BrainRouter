import { load } from 'cheerio';
import { normalizeResult, type WebSearchResult } from '../types.js';

/**
 * Google web search via the in-app Chromium (NOT raw HTTP — Google blocks
 * server-side scraping with consent walls / CAPTCHAs). The agent navigates a
 * background tab to the results page and this parses the RENDERED HTML.
 *
 * Google's SERP DOM is obfuscated and changes often, so the parser is
 * deliberately structural: every organic result's title is an <h3> inside the
 * result's anchor, and the anchor's href is the destination (sometimes wrapped
 * in Google's /url?q= redirect). That title↔anchor relationship is far more
 * stable than the churning CSS class names. Callers may use an explicitly
 * configured API provider when this returns nothing.
 */

/** Google sometimes wraps a result href in `/url?q=<real>&...`; unwrap it. */
export function unwrapGoogleUrl(href: string): string {
  try {
    const u = new URL(href, 'https://www.google.com');
    if (u.pathname === '/url') {
      const real = u.searchParams.get('q') || u.searchParams.get('url');
      if (real) return real;
    }
    return u.toString();
  } catch {
    return href;
  }
}

/** Google's own hosts (search chrome, account, consent, cache, maps tiles) are
 *  never organic web results — drop them after unwrapping. */
export function isGoogleInternal(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      /(^|\.)google\.[a-z.]+$/.test(host) ||
      /(^|\.)gstatic\.com$/.test(host) ||
      /(^|\.)googleusercontent\.com$/.test(host) ||
      host === 'webcache.googleusercontent.com'
    );
  } catch {
    return true;
  }
}

/** Parse a rendered Google results page into ranked {title,url,snippet}. */
export function parseGoogleHtml(html: string, limit: number): WebSearchResult[] {
  const $ = load(html);
  const out: WebSearchResult[] = [];
  const seen = new Set<string>();
  $('a:has(h3)').each((_index, a) => {
    if (out.length >= limit) return false;
    const anchor = $(a);
    const href = anchor.attr('href') || '';
    if (!href) return undefined;
    const url = unwrapGoogleUrl(href);
    if (!/^https?:\/\//i.test(url) || isGoogleInternal(url) || seen.has(url)) return undefined;
    const title = anchor.find('h3').first().text().trim();
    if (!title) return undefined;
    // Snippet: the description sits in a sibling of the title block within the
    // same result container. Walk up to the result and take the first sizeable
    // text node that isn't the title itself — best-effort, empty if not found.
    const container = anchor.closest('div.g, div[data-hveid], div[data-sokoban-container]').first();
    let snippet = container.find('div[data-sncf], .VwiC3b, div[role="text"]').first().text().trim();
    if (!snippet) {
      const raw = container.text().replace(title, ' ').replace(/\s+/g, ' ').trim();
      snippet = raw.length > 40 ? raw.slice(0, 300) : '';
    }
    seen.add(url);
    const item = normalizeResult({ title, url, snippet });
    if (item) out.push(item);
    return undefined;
  });
  return out.slice(0, limit);
}

/** The URL the in-app browser should navigate to for a Google query.
 *  Language and region intentionally come from the persistent browser session
 *  and network rather than a fabricated country parameter. `num` asks for
 *  enough organic rows. */
export function googleSearchUrl(query: string, maxResults: number, page = 1): string {
  const num = Math.max(10, Math.min(20, maxResults * 2));
  const start = Math.max(0, Math.min(90, (Math.floor(page) - 1) * 10));
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num}&start=${start}&pws=0`;
}
