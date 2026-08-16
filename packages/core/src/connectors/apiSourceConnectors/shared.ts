import type { ConnectorCheckpoint, ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type { ApiConnectorRunResult, TokenClientOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

export function apiResult(documents: ConnectorDocument[], failures: string[], now: string, checkpoint: ConnectorCheckpoint): ApiConnectorRunResult {
  return {
    documents,
    failures,
    checkpoint: {
      ...checkpoint,
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
    },
  };
}

export function tokenJsonClient(root: string, headers: Record<string, string>, options?: TokenClientOptions) {
  const fetcher = options?.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 30_000);
  const apiRoot = stripTrailing(root);
  const request = async (method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<unknown> => {
    const url = new URL(`${apiRoot}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const res = await fetcher(url, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${apiRoot} ${method} ${url.pathname} failed: ${res.status} ${res.statusText}`);
    return res.json();
  };
  return {
    get: (path: string, query?: Record<string, string>) => request('GET', path, query),
    post: (path: string, body?: unknown) => request('POST', path, undefined, body),
  };
}

export function commentsText(comments?: Array<{ author?: string; body: string; updatedAt?: string }>): string | undefined {
  if (!comments?.length) return undefined;
  return comments.map((comment) => [`Comment${comment.author ? ` by ${comment.author}` : ''}${comment.updatedAt ? ` at ${comment.updatedAt}` : ''}`, comment.body].join('\n')).join('\n\n');
}

export function richText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return htmlToText(value);
  if (Array.isArray(value)) return value.map(richText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text : typeof row.plain_text === 'string' ? row.plain_text : '';
    const content = Array.isArray(row.content) ? row.content.map(richText).filter(Boolean).join('\n') : '';
    return [text, content].filter(Boolean).join('\n');
  }
  return String(value);
}

export function htmlToText(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function checkpointHighWatermark(connector: ConnectorRecord): string | undefined {
  return typeof connector.checkpoint?.highWatermark === 'string' ? connector.checkpoint.highWatermark : undefined;
}

export function maxIso(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}

export function slackTsToIso(ts: string): string | undefined {
  const seconds = Number(ts.split('.')[0]);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

export function configString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function configStringList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => item.trim()).filter(Boolean);
}

export function safeMaxItems(value: number | undefined): number {
  return Math.max(1, Math.min(1000, Math.floor(value ?? 200)));
}

export function requireToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

export function stripTrailing(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Connector base URL is required.');
  return stripTrailingSlashes(trimmed);
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
