import { createHash } from 'node:crypto';
import type {
  ConnectorCheckpoint,
  ConnectorDocument,
  ConnectorRecord,
} from '@kinqs/brainrouter-types';

export interface WebConnectorPage {
  status: number;
  contentType: string;
  body: string;
  links: string[];
}

export interface WebConnectorClient {
  fetchPage(url: string): Promise<WebConnectorPage>;
}

export interface WebConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface WebConnectorRunOptions {
  now?: string;
  maxPages?: number;
}

export const WEB_DEFAULT_DEPTH = 1;
export const WEB_MAX_DEPTH = 3;
export const WEB_MAX_PAGES_PER_RUN = 50;

export async function runWebConnectorCheckpoint(
  connector: ConnectorRecord,
  client: WebConnectorClient,
  options?: WebConnectorRunOptions,
): Promise<WebConnectorRunResult> {
  if (connector.source !== 'web') throw new Error(`Connector source ${connector.source} is not web.`);
  const baseUrl = parseHttpUrl(configString(connector, 'baseUrl'));
  if (!baseUrl) throw new Error('Web connector requires a valid http(s) baseUrl.');
  const mode = configString(connector, 'mode');
  const maxDepth = mode === 'single' ? 0 : clampDepth(connector.config.depth);
  const maxPages = Math.max(1, Math.floor(options?.maxPages ?? WEB_MAX_PAGES_PER_RUN));
  const now = options?.now ?? new Date().toISOString();

  const start = normalizeUrl(baseUrl);
  const visited = new Set<string>([start]);
  const queue: Array<{ url: string; depth: number }> = [{ url: start, depth: 0 }];
  const documents: ConnectorDocument[] = [];
  const failures: string[] = [];
  let fetched = 0;

  // Web pages have no reliable mtime, so every run re-crawls and re-emits all
  // reachable pages; the checkpoint only records the last run. One request at
  // a time by construction — the loop awaits each fetch before the next.
  while (queue.length > 0 && fetched < maxPages) {
    const next = queue.shift() as { url: string; depth: number };
    fetched += 1;
    let page: WebConnectorPage;
    try {
      page = await client.fetchPage(next.url);
    } catch (err) {
      failures.push(`${next.url}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (page.status < 200 || page.status >= 300) {
      failures.push(`${next.url}: HTTP ${page.status}`);
      continue;
    }
    if (isUnsupportedContentType(page.contentType)) {
      failures.push(`${next.url}: unsupported content type ${page.contentType}.`);
      continue;
    }
    if (page.body.includes('\u0000')) {
      failures.push(`${next.url}: binary content skipped.`);
      continue;
    }
    const html = isHtmlPage(page);
    const { title, text } = html
      ? extractHtmlText(page.body)
      : { title: '', text: collapseWhitespace(page.body) };
    documents.push(pageDocument(connector, next.url, next.depth, page, title, text, now));
    if (!html || next.depth >= maxDepth) continue;
    for (const raw of page.links) {
      const link = resolveSameOriginLink(raw, next.url, baseUrl.origin);
      if (!link || visited.has(link)) continue;
      visited.add(link);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }
  if (queue.length > 0) {
    failures.push(`Stopped after ${maxPages} pages; ${queue.length} discovered links were not fetched.`);
  }

  return {
    documents,
    failures,
    checkpoint: {
      lastRunAt: now,
      baseUrl: start,
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
      pagesFetched: fetched,
    },
  };
}

export interface FetchWebClientOptions {
  headerToken?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

export function fetchWebClient(options?: FetchWebClientOptions): WebConnectorClient {
  const fetcher = options?.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 15_000);
  const maxBodyBytes = Math.max(1, options?.maxBodyBytes ?? 2 * 1024 * 1024);
  const headers: Record<string, string> = {
    'User-Agent': options?.userAgent ?? 'brainrouter-web-connector',
    Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
  };
  if (options?.headerToken) headers.Authorization = `Bearer ${options.headerToken}`;
  return {
    async fetchPage(url) {
      const res = await fetcher(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const contentType = res.headers.get('content-type') ?? '';
      const buf = Buffer.from(await res.arrayBuffer());
      const body = buf.subarray(0, maxBodyBytes).toString('utf8');
      const finalUrl = res.url || url;
      const htmlish = /html|xml/i.test(contentType) || !contentType;
      return {
        status: res.status,
        contentType,
        body,
        links: res.ok && htmlish ? extractSameOriginLinks(body, finalUrl) : [],
      };
    },
  };
}

export function extractSameOriginLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return links;
  }
  const hrefPattern = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    const resolved = resolveSameOriginLink(raw, pageUrl, origin);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    links.push(resolved);
  }
  return links;
}

function pageDocument(
  connector: ConnectorRecord,
  url: string,
  depth: number,
  page: WebConnectorPage,
  title: string,
  text: string,
  now: string,
): ConnectorDocument {
  return {
    id: `web:${connector.id}:${hashUrl(url)}`,
    connectorId: connector.id,
    source: 'web',
    kind: 'file',
    repository: new URL(url).origin,
    title: title || url,
    url,
    updatedAt: now,
    text,
    metadata: { url, depth, status: page.status, contentType: page.contentType },
  };
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function extractHtmlText(html: string): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').trim() ?? '';
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return { title: decodeBasicEntities(title), text: collapseWhitespace(decodeBasicEntities(text)) };
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function isHtmlPage(page: WebConnectorPage): boolean {
  if (/html|xhtml|xml/i.test(page.contentType)) return true;
  if (page.contentType) return false;
  return /<html[\s>]|<!doctype html/i.test(page.body.slice(0, 1024));
}

function isUnsupportedContentType(contentType: string): boolean {
  return /image\/|video\/|audio\/|font\/|application\/(octet-stream|pdf|zip|gzip|x-tar)/i.test(contentType);
}

function resolveSameOriginLink(raw: string, pageUrl: string, origin: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, pageUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    if (resolved.origin !== origin) return undefined;
    resolved.hash = '';
    return resolved.href;
  } catch {
    return undefined;
  }
}

function normalizeUrl(url: URL): string {
  const clone = new URL(url.href);
  clone.hash = '';
  return clone.href;
}

function parseHttpUrl(value: string): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function clampDepth(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  const depth = Number.isFinite(parsed) ? Math.floor(parsed) : WEB_DEFAULT_DEPTH;
  return Math.min(WEB_MAX_DEPTH, Math.max(0, depth));
}

function configString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}
