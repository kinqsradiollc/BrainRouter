import dns from 'node:dns';
import net from 'node:net';
import { load } from 'cheerio';
import type { CrawlResult, CrawlerOptions } from './types.js';
import { isAllowedByRobots } from './robots.js';

const hostNextFetchAt = new Map<string, number>();
const MAX_REDIRECTS = 5;

/** True for any address the agent's web tools must never reach: loopback,
 *  RFC1918 private, CGNAT, link-local (incl. 169.254.169.254 cloud metadata),
 *  IPv6 loopback/ULA/link-local, and anything unparsable (fail closed). This is
 *  the core SSRF guard — without it fetch_url could hit internal services and
 *  cloud metadata endpoints. */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const v = mapped ? mapped[1] : ip;
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 127) return true;               // unspecified / loopback
    if (a === 10) return true;                            // 10/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16/12 private
    if (a === 192 && b === 168) return true;              // 192.168/16 private
    if (a === 169 && b === 254) return true;              // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (low === '::1' || low === '::') return true;       // loopback / unspecified
    if (low.startsWith('fe80') || low.startsWith('fec0')) return true; // link/site-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true;     // fc00::/7 ULA
    return false;
  }
  return true; // unknown format → fail closed
}

/** Resolve `hostname` and return a block reason if it (or any resolved IP) is a
 *  non-public address. A literal IP is checked directly; a name is DNS-resolved
 *  and every A/AAAA record checked (re-run per redirect hop to blunt rebinding).
 *  DNS failure returns null so the real fetch surfaces a normal network error. */
async function privateAddressReason(hostname: string): Promise<string | null> {
  if (net.isIP(hostname)) {
    return isBlockedAddress(hostname) ? `Refusing to fetch a non-public address (${hostname}).` : null;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return null;
  }
  const bad = records.find((r) => isBlockedAddress(r.address));
  return bad ? `Refusing to fetch ${hostname} — it resolves to a non-public address (${bad.address}).` : null;
}

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
    // Follow redirects manually so the SSRF + egress checks run on EVERY hop —
    // the default auto-follow let a public URL 30x-redirect straight to an
    // internal IP / cloud metadata, bypassing both guards.
    let res!: Response;
    for (let hop = 0; ; hop++) {
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { ok: false, url: parsed.href, reason: 'network', error: 'Only HTTP and HTTPS URLs can be fetched.' };
      }
      if (opts.isEgressAllowed && !opts.isEgressAllowed(parsed.href)) {
        return { ok: false, url: parsed.href, reason: 'network', error: 'A redirect target was blocked by egress policy.' };
      }
      // SSRF guard on the REAL network path only — a mock fetchImpl controls its
      // own egress (and fake test hosts must not hit real DNS).
      if (!opts.fetchImpl) {
        const reason = await privateAddressReason(parsed.hostname);
        if (reason) return { ok: false, url: parsed.href, reason: 'network', error: reason };
      }
      await waitForHost(parsed.href, opts.ratePerHostMs);
      res = await fetcher(parsed, { headers: { 'User-Agent': opts.userAgent }, signal, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        if (hop >= MAX_REDIRECTS) {
          return { ok: false, url: parsed.href, reason: 'network', error: `Too many redirects (>${MAX_REDIRECTS}).` };
        }
        try { parsed = new URL(location, parsed); } catch {
          return { ok: false, url: parsed.href, reason: 'network', error: 'A redirect returned an invalid location.' };
        }
        continue;
      }
      break;
    }
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
