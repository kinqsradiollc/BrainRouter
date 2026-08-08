/**
 * ADR-029 F3 — a bookmark shows what it points at, and stays a link when it cannot.
 *
 * The slash menu has offered `Bookmark` since Part E and it inserted a line of
 * text (F1). What makes it a bookmark is a fetched title, description and icon —
 * and the fetch is the whole risk in this file, because the URL is whatever
 * somebody pasted.
 *
 * **The fetch is not written here.** `net/guardedFetch.ts` owns the per-hop SSRF
 * check, the redirect cap, the body cap and the timeout, and this module is one
 * of its callers rather than a second policy. A bookmark preview reaching an
 * internal service is the same defect as `fetch_url` reaching one, and it should
 * not be possible to fix in one place and not the other.
 *
 * **The parse is bounded on purpose.** Every expression below has a single
 * bounded character class and no nested or adjacent unbounded repetition, and
 * the document is sliced to a head-sized prefix before any of them run: this
 * repository closed a polynomial-ReDoS alert, and HTML from an arbitrary host is
 * exactly the input that finds one. `bookmark-preview.test.ts` runs the parser
 * against a 100k adversarial document for that reason.
 *
 * **A preview that fails is not a broken bookmark.** Every failure path still
 * yields the URL and its host, because a link that cannot be previewed is still
 * a link that works — and an empty card is the "offer the product cannot honour"
 * F1 exists to remove.
 */
import { fetchGuardedBytes } from '../net/guardedFetch.js';
import { asInlineLabel } from '../workspace/references/resolution.js';

/** Only the head is worth scanning, and only a bounded prefix of it. */
const MAX_HTML_SCAN = 128_000;
/** A page is not allowed to cost more than this to preview. */
export const MAX_BOOKMARK_HTML_BYTES = 512 * 1024;
/** An icon big enough to be one, small enough to inline. */
export const MAX_BOOKMARK_ICON_BYTES = 64 * 1024;
export const BOOKMARK_FETCH_TIMEOUT_MS = 8_000;

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 240;

export interface BookmarkPreview {
  /** The FINAL address after redirects — what the icon and the host describe. */
  url: string;
  host: string;
  title: string;
  description: string;
  /** A `data:` URI, because the renderer's CSP allows `self` and `data:` only. */
  iconDataUri?: string;
}

/**
 * Why there is no preview.
 *
 * Named rather than collapsed into one "failed", because the reader's next move
 * differs: a blocked address is never going to work, an unreachable host might
 * work in a minute, and a page that is not HTML has nothing to preview and is
 * still perfectly good to open.
 */
export type BookmarkFailure =
  | 'not_a_url'
  | 'blocked'
  | 'unreachable'
  | 'timeout'
  | 'oversized'
  | 'http_error'
  | 'not_a_page';

export type BookmarkPreviewResult =
  | { ok: true; preview: BookmarkPreview }
  | { ok: false; url: string; host: string; reason: BookmarkFailure; detail: string };

/* ------------------------------------------------------------------ parsing */

/** Attributes we read. A fixed list, so no expression is ever built from input. */
type MetaTag = { tag: string };

type AttrName = 'property' | 'name' | 'content' | 'rel' | 'href';

/**
 * The attribute expressions, built once.
 *
 * Each value alternative is a single bounded character class, so matching is
 * linear in the tag's length and the tag is already capped by the scan that
 * produced it. Module-level rather than per call because these are constants,
 * and a regex literal inside a function is recompiled on every tag of every
 * page.
 */
const ATTR_PATTERNS: Record<AttrName, RegExp> = {
  property: /\bproperty\s{0,4}=\s{0,4}("[^"]{0,300}"|'[^']{0,300}'|[^\s"'>]{0,300})/i,
  name: /\bname\s{0,4}=\s{0,4}("[^"]{0,300}"|'[^']{0,300}'|[^\s"'>]{0,300})/i,
  content: /\bcontent\s{0,4}=\s{0,4}("[^"]{0,600}"|'[^']{0,600}'|[^\s"'>]{0,600})/i,
  rel: /\brel\s{0,4}=\s{0,4}("[^"]{0,300}"|'[^']{0,300}'|[^\s"'>]{0,300})/i,
  href: /\bhref\s{0,4}=\s{0,4}("[^"]{0,600}"|'[^']{0,600}'|[^\s"'>]{0,600})/i,
};

/** One attribute out of one tag, unquoted and entity-decoded. */
function attr(tag: string, name: AttrName): string {
  const raw = ATTR_PATTERNS[name].exec(tag)?.[1] ?? '';
  const unquoted = raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'"))
    ? raw.slice(1, -1)
    : raw;
  return decodeEntities(unquoted).trim();
}

/**
 * The five entities that actually appear in a title, and nothing else.
 *
 * A full entity table would be a second HTML parser; these five cover what a
 * `<title>` or a description contains in practice, and anything left un-decoded
 * renders as itself rather than as a mistake.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0{0,4}39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/** Every `<meta>` / `<link>` in the scanned prefix, as raw tag text. */
function headTags(html: string): MetaTag[] {
  const out: MetaTag[] = [];
  // One bounded class, then the closing bracket. Linear in the input, and the
  // input is already sliced.
  const scanner = /<(?:meta|link)\s[^>]{0,800}>/gi;
  for (const match of html.matchAll(scanner)) out.push({ tag: match[0] });
  return out;
}

export interface BookmarkMeta {
  title: string;
  description: string;
  /** As written in the document — still relative at this point. */
  iconHref: string;
}

/**
 * Title, description and icon out of a page's head. Pure, bounded, total.
 *
 * Open Graph first because it is what a page's author wrote FOR this use; the
 * `<title>` is frequently the site's name plus a separator plus the page's, and
 * showing that as a bookmark's title is how every card ends up starting with the
 * same eight characters.
 */
export function parseBookmarkMeta(html: string): BookmarkMeta {
  const scanned = typeof html === 'string' ? html.slice(0, MAX_HTML_SCAN) : '';
  const tags = headTags(scanned);

  const metaValue = (...keys: string[]): string => {
    for (const key of keys) {
      for (const { tag } of tags) {
        if (!/^<meta/i.test(tag)) continue;
        const id = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
        if (id !== key) continue;
        const content = attr(tag, 'content');
        if (content) return content;
      }
    }
    return '';
  };

  const documentTitle = decodeEntities(
    /<title[^>]{0,200}>([^<]{0,400})/i.exec(scanned)?.[1] ?? '',
  );

  let iconHref = '';
  for (const { tag } of tags) {
    if (!/^<link/i.test(tag)) continue;
    const rel = attr(tag, 'rel').toLowerCase();
    // `icon`, `shortcut icon`, `apple-touch-icon` — the three spellings that are
    // actually in the wild. First one wins: a page listing five sizes is listing
    // them in its own order of preference.
    if (!/(?:^|\s)(?:shortcut\s{1,4})?icon$/.test(rel) && !rel.includes('apple-touch-icon')) continue;
    const href = attr(tag, 'href');
    if (href) { iconHref = href; break; }
  }

  return {
    // Neutralised through the shared helper, because a title is content somebody
    // else wrote and it lands inline in the reader's own document (C4).
    title: asInlineLabel(metaValue('og:title', 'twitter:title') || documentTitle, MAX_TITLE),
    description: asInlineLabel(
      metaValue('og:description', 'twitter:description', 'description'),
      MAX_DESCRIPTION,
    ),
    iconHref,
  };
}

/** The label a bookmark falls back to: the host, then the path if there is one. */
export function bookmarkFallbackTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return asInlineLabel(path && path !== '' ? `${parsed.host}${path}` : parsed.host, MAX_TITLE);
  } catch {
    return asInlineLabel(url, MAX_TITLE);
  }
}

export function bookmarkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ fetching */

export interface BookmarkFetchOptions {
  userAgent: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const FAILURE_FOR: Record<string, BookmarkFailure> = {
  network: 'unreachable',
  timeout: 'timeout',
  oversized: 'oversized',
  'http-status': 'http_error',
};

/**
 * Fetch a page and read its preview, or say exactly why there is none.
 *
 * `robots.txt` is deliberately not consulted, and that is a decision rather than
 * an omission: robots governs CRAWLING, and this is one fetch of one page a
 * person has already decided to keep a link to. Every guard that protects the
 * machine — the address check, the redirect cap, the size cap, the timeout —
 * still applies, because those protect against the URL rather than against
 * impoliteness.
 */
export async function fetchBookmarkPreview(
  rawUrl: string,
  opts: BookmarkFetchOptions,
): Promise<BookmarkPreviewResult> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { ok: false, url: String(rawUrl ?? ''), host: '', reason: 'not_a_url', detail: 'That is not a web address.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false, url: parsed.href, host: parsed.host, reason: 'not_a_url',
      detail: 'Only http and https addresses can be previewed.',
    };
  }

  const timeoutMs = opts.timeoutMs ?? BOOKMARK_FETCH_TIMEOUT_MS;
  const page = await fetchGuardedBytes(parsed.href, {
    timeoutMs,
    maxBytes: MAX_BOOKMARK_HTML_BYTES,
    userAgent: opts.userAgent,
    accept: 'text/html,application/xhtml+xml',
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (!page.ok) {
    // A refusal by the address guard reads differently from a host that is
    // simply down, and the guard's own sentence already says which.
    const blocked = page.reason === 'network' && page.error.startsWith('Refusing to fetch');
    return {
      ok: false,
      url: parsed.href,
      host: parsed.host,
      reason: blocked ? 'blocked' : FAILURE_FOR[page.reason] ?? 'unreachable',
      detail: page.error,
    };
  }

  const html = page.bytes.toString('utf8');
  const looksLikeHtml = /html|xml/i.test(page.contentType) || /<html[\s>]|<!doctype html/i.test(html.slice(0, 2_000));
  if (!looksLikeHtml) {
    return {
      ok: false, url: page.url, host: bookmarkHost(page.url), reason: 'not_a_page',
      detail: 'That address is a file rather than a page, so there is nothing to preview.',
    };
  }

  const meta = parseBookmarkMeta(html);
  const icon = await fetchBookmarkIcon(page.url, meta.iconHref, { ...opts, timeoutMs });

  return {
    ok: true,
    preview: {
      url: page.url,
      host: bookmarkHost(page.url),
      title: meta.title || bookmarkFallbackTitle(page.url),
      description: meta.description,
      ...(icon ? { iconDataUri: icon } : {}),
    },
  };
}

/**
 * The site's icon as a `data:` URI, or nothing.
 *
 * Nothing rather than a URL: the renderer's CSP is `img-src 'self' data:`, so an
 * `https://` icon would render as a broken image inside a card whose whole job
 * is to look like the site. Failing to find one is not an error — the card falls
 * back to the host's initial, which is always available.
 */
async function fetchBookmarkIcon(
  pageUrl: string,
  href: string,
  opts: BookmarkFetchOptions & { timeoutMs: number },
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (href) {
    try { candidates.push(new URL(href, pageUrl).href); } catch { /* a malformed href is not an error */ }
  }
  try { candidates.push(new URL('/favicon.ico', pageUrl).href); } catch { /* unreachable: pageUrl parsed already */ }

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchGuardedBytes(candidate, {
      timeoutMs: opts.timeoutMs,
      maxBytes: MAX_BOOKMARK_ICON_BYTES,
      userAgent: opts.userAgent,
      accept: 'image/*',
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    if (!res.ok || res.bytes.byteLength === 0) continue;
    const mime = res.contentType.split(';')[0]?.trim() ?? '';
    // A server that answers the 404 page for a missing favicon sends HTML with
    // a 200; rendering that as an image is the broken glyph this avoids.
    if (!mime.startsWith('image/')) continue;
    return `data:${mime};base64,${res.bytes.toString('base64')}`;
  }
  return undefined;
}
