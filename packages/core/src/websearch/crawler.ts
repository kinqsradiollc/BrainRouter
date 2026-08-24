import type { CrawlResult, CrawlerOptions } from './types.js';
import { isAllowedByRobots } from './robots.js';
import { fetchGuardedBytes, MAX_GUARDED_REDIRECTS } from '../net/guardedFetch.js';
import { htmlToMarkdown } from './htmlToMarkdown.js';

const hostNextFetchAt = new Map<string, number>();

/**
 * The SSRF guard moved to `net/guardedFetch.ts` when ADR-029 F3 gave it two
 * more callers (a bookmark preview, an image pasted as an address). It is
 * re-exported here because a second implementation of "which addresses are
 * off-limits" is the defect this codebase has already paid for once — and
 * because the existing importers name this module.
 */
export { isBlockedAddress } from '../net/guardedFetch.js';

export function clearCrawlerStateForTests(): void {
  hostNextFetchAt.clear();
}

async function waitForHost(url: string, ratePerHostMs: number): Promise<void> {
  if (ratePerHostMs <= 0) return;
  const host = new URL(url).host;
  const now = Date.now();
  const next = hostNextFetchAt.get(host) ?? 0;
  const waitMs = Math.max(0, next - now);
  hostNextFetchAt.set(host, Math.max(now, next) + ratePerHostMs);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function cleanText(text: string, maxContentChars: number): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxContentChars);
}

function regexExtract(html: string, maxContentChars: number): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim() ?? '';
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return { title, text: cleanText(text, maxContentChars) };
}

/**
 * Structure-preserving extraction (ADR-044 M1). Walks the DOM to markdown —
 * tables stay tables, links keep their hrefs, code keeps its fences — instead
 * of the old `$('body').text()` flatten that fed the model a run of words. The
 * regex extractor remains the fallback for documents the walker cannot parse
 * (it never throws, so an empty result is the signal to fall back).
 */
function extractHtml(html: string, maxContentChars: number, pageUrl: string): { title: string; text: string } {
  try {
    const { title, markdown } = htmlToMarkdown(html, pageUrl, maxContentChars);
    if (!markdown) return regexExtract(html, maxContentChars);
    return { title, text: markdown };
  } catch {
    return regexExtract(html, maxContentChars);
  }
}

export async function fetchAndExtract(url: string, opts: CrawlerOptions): Promise<CrawlResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, reason: 'network', error: 'Invalid URL.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, url, reason: 'network', error: 'Only HTTP and HTTPS URLs can be fetched.' };
  }

  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, opts.timeoutMs)),
    ...(opts.signal ? [opts.signal] : []),
  ]);
  const fetcher = opts.fetchImpl ?? fetch;
  const robots = await isAllowedByRobots(parsed.href, {
    userAgent: opts.userAgent,
    respectRobots: opts.respectRobots,
    signal,
    fetchImpl: fetcher,
  });
  if (!robots.allowed) {
    return { ok: false, url: parsed.href, reason: 'robots-blocked', error: robots.reason ?? 'Blocked by robots.txt.' };
  }

  // The redirect chain, the per-hop SSRF check and the size caps are the shared
  // guard's, not this file's: `fetch_url`, a bookmark preview and an image
  // pasted as an address all reach a URL a person typed, and three copies of
  // that policy is three chances for one of them to be the weak one.
  const fetched = await fetchGuardedBytes(parsed.href, {
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxHtmlBytes,
    userAgent: opts.userAgent,
    maxRedirects: MAX_GUARDED_REDIRECTS,
    signal,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.isEgressAllowed ? { isEgressAllowed: opts.isEgressAllowed } : {}),
    beforeHop: (href) => waitForHost(href, opts.ratePerHostMs),
  });
  if (!fetched.ok) {
    return {
      ok: false,
      url: fetched.url,
      reason: fetched.reason,
      error: fetched.error,
      ...(fetched.status === undefined ? {} : { status: fetched.status }),
    };
  }

  const raw = fetched.bytes.toString('utf8');
  const isHtml = /html|xml/i.test(fetched.contentType) || /<html[\s>]|<!doctype html/i.test(raw);
  const extracted = isHtml
    ? extractHtml(raw, opts.maxContentChars, fetched.url)
    : { title: '', text: cleanText(raw, opts.maxContentChars) };
  if (!extracted.text) {
    return { ok: false, url: fetched.url, reason: 'unparseable', error: 'No readable text could be extracted.' };
  }
  return {
    ok: true,
    title: extracted.title,
    url: fetched.url,
    text: extracted.text,
    contentType: fetched.contentType,
  };
}
