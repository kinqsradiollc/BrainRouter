import { load } from 'cheerio';
import type { CrawlResult, CrawlerOptions } from './types.js';
import { isAllowedByRobots } from './robots.js';

const hostNextFetchAt = new Map<string, number>();

export function clearCrawlerStateForTests(): void {
  hostNextFetchAt.clear();
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
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

function extractHtml(html: string, maxContentChars: number): { title: string; text: string } {
  try {
    const $ = load(html);
    const title = $('title').first().text().trim();
    $('script,style,noscript,svg,canvas,template,nav,header,footer,aside').remove();
    $('br').replaceWith('\n');
    $('li').each((_, el) => { $(el).prepend('- '); $(el).append('\n'); });
    $('p,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,section,article,div').each((_, el) => { $(el).append('\n'); });
    const body = $('body').text() || $.root().text();
    const text = cleanText(body, maxContentChars);
    if (!text) return regexExtract(html, maxContentChars);
    return { title, text };
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

  const signal = combineSignals(opts.timeoutMs, opts.signal);
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

  try {
    await waitForHost(parsed.href, opts.ratePerHostMs);
    const res = await fetcher(parsed, { headers: { 'User-Agent': opts.userAgent }, signal });
    if (!res.ok) {
      return { ok: false, url: parsed.href, reason: 'http-status', status: res.status, error: `${res.status} ${res.statusText}` };
    }
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > opts.maxHtmlBytes) {
      return { ok: false, url: parsed.href, reason: 'oversized', error: `Response is ${contentLength} bytes; limit is ${opts.maxHtmlBytes}.` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > opts.maxHtmlBytes) {
      return { ok: false, url: parsed.href, reason: 'oversized', error: `Response is ${buf.byteLength} bytes; limit is ${opts.maxHtmlBytes}.` };
    }
    const raw = buf.toString('utf8');
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = /html|xml/i.test(contentType) || /<html[\s>]|<!doctype html/i.test(raw);
    const extracted = isHtml
      ? extractHtml(raw, opts.maxContentChars)
      : { title: '', text: cleanText(raw, opts.maxContentChars) };
    if (!extracted.text) {
      return { ok: false, url: parsed.href, reason: 'unparseable', error: 'No readable text could be extracted.' };
    }
    return {
      ok: true,
      title: extracted.title,
      url: parsed.href,
      text: extracted.text,
      contentType,
    };
  } catch (err: any) {
    const aborted = signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      ok: false,
      url: parsed.href,
      reason: aborted ? 'timeout' : 'network',
      error: err?.message ?? String(err),
    };
  }
}
