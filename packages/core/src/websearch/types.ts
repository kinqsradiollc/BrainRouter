export const WEB_SEARCH_PROVIDERS = ['serper', 'google_pse', 'brave', 'searxng', 'custom_http'] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  author?: string;
  publishedDate?: string;
}

export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

export const FAILURE_REASONS = ['network', 'timeout', 'oversized', 'http-status', 'robots-blocked', 'unparseable'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type CrawlResult =
  | { ok: true; title: string; url: string; text: string; contentType?: string }
  | { ok: false; url: string; reason: FailureReason; error: string; status?: number };

export interface CrawlerOptions {
  respectRobots: boolean;
  maxContentChars: number;
  maxHtmlBytes: number;
  timeoutMs: number;
  ratePerHostMs: number;
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Re-checked per redirect hop so a redirect can't leave the egress allowlist
   *  (the handler only vets the initial URL). Return false to block a target. */
  isEgressAllowed?: (url: string) => boolean;
}

export function normalizeResult(input: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  author?: unknown;
  publishedDate?: unknown;
}): WebSearchResult | null {
  const title = String(input.title ?? '').trim();
  const url = String(input.url ?? '').trim();
  const snippet = String(input.snippet ?? '').trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    snippet,
    ...(typeof input.author === 'string' && input.author.trim() ? { author: input.author.trim() } : {}),
    ...(typeof input.publishedDate === 'string' && input.publishedDate.trim() ? { publishedDate: input.publishedDate.trim() } : {}),
  };
}

export function clampMaxResults(maxResults: number, max = 10): number {
  return Math.max(1, Math.min(max, Math.floor(Number.isFinite(maxResults) ? maxResults : 5)));
}
