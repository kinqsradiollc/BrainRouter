import type { ConnectorCheckpoint, ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  url?: string;
  updatedAt?: string;
  parents?: string[];
  text?: string;
}

export interface GoogleDriveConnectorClient {
  listFiles(opts: { folderIds: string[]; since?: string; includeSharedDrives?: boolean; includeSheets?: boolean; limit?: number }): Promise<GoogleDriveFile[]>;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  url?: string;
  updatedAt?: string;
  snippet?: string;
  text?: string;
}

export interface GmailConnectorClient {
  listMessages(opts: { query?: string; since?: string; limit?: number }): Promise<GmailMessage[]>;
}

export interface GoogleConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export async function runGoogleDriveConnectorCheckpoint(
  connector: ConnectorRecord,
  client: GoogleDriveConnectorClient,
  options?: { now?: string; maxItems?: number },
): Promise<GoogleConnectorRunResult> {
  if (connector.source !== 'google-drive') throw new Error(`Connector source ${connector.source} is not google-drive.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const maxItems = safeLimit(options?.maxItems, 500);
  const files = await client.listFiles({
    folderIds: configStringList(connector, 'folderIds'),
    since,
    includeSharedDrives: connector.config.includeSharedDrives !== false,
    includeSheets: connector.config.includeSheets !== false,
    limit: maxItems,
  });
  const documents = files.slice(0, maxItems).map((file) => driveFileDocument(connector, file));
  const failures = files.length > maxItems ? [`Stopped after ${maxItems} Google Drive files.`] : [];
  return result(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), fileCount: documents.length });
}

export async function runGmailConnectorCheckpoint(
  connector: ConnectorRecord,
  client: GmailConnectorClient,
  options?: { now?: string; maxItems?: number },
): Promise<GoogleConnectorRunResult> {
  if (connector.source !== 'gmail') throw new Error(`Connector source ${connector.source} is not gmail.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const maxItems = safeLimit(options?.maxItems, 500);
  const messages = await client.listMessages({ query: configString(connector, 'query'), since, limit: maxItems });
  const documents = messages.slice(0, maxItems).map((message) => gmailMessageDocument(connector, message));
  const failures = messages.length > maxItems ? [`Stopped after ${maxItems} Gmail messages.`] : [];
  return result(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), messageCount: documents.length });
}

export interface GoogleTokenClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function googleDriveTokenClient(token: string, options?: GoogleTokenClientOptions): GoogleDriveConnectorClient {
  const client = googleClient('https://www.googleapis.com/drive/v3', token, options);
  return {
    async listFiles(opts) {
      const queries = ['trashed = false'];
      if (opts.since) queries.push(`modifiedTime > '${opts.since}'`);
      const folderQueries = opts.folderIds.length ? opts.folderIds.map((id) => `'${id.replace(/'/g, "\\'")}' in parents`) : [];
      const q = folderQueries.length ? `${queries.join(' and ')} and (${folderQueries.join(' or ')})` : queries.join(' and ');
      const rows = await googlePaginate<Record<string, unknown>>(client, '/files', {
        q,
        pageSize: String(Math.max(1, Math.min(100, opts.limit ?? 100))),
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: opts.includeSharedDrives === false ? 'false' : 'true',
      }, 'files');
      const files: GoogleDriveFile[] = [];
      for (const row of rows.slice(0, opts.limit ?? 100)) {
        const file = driveFileFromRow(row);
        file.text = await driveFileText(client, file, opts.includeSheets !== false).catch(() => undefined);
        files.push(file);
      }
      return files;
    },
  };
}

export function gmailTokenClient(token: string, options?: GoogleTokenClientOptions): GmailConnectorClient {
  const client = googleClient('https://gmail.googleapis.com/gmail/v1/users/me', token, options);
  return {
    async listMessages(opts) {
      const q = [opts.query?.trim(), opts.since ? `after:${Math.floor(Date.parse(opts.since) / 1000)}` : ''].filter(Boolean).join(' ');
      const rows = await googlePaginate<{ id?: string; threadId?: string }>(client, '/messages', {
        maxResults: String(Math.max(1, Math.min(100, opts.limit ?? 100))),
        ...(q ? { q } : {}),
      }, 'messages');
      const messages: GmailMessage[] = [];
      for (const row of rows.slice(0, opts.limit ?? 100)) {
        if (!row.id) continue;
        const data = await client.get(`/messages/${encodeURIComponent(row.id)}`, { format: 'full' }) as Record<string, unknown>;
        messages.push(gmailMessageFromRow(data));
      }
      return messages;
    },
  };
}

function driveFileDocument(connector: ConnectorRecord, file: GoogleDriveFile): ConnectorDocument {
  return {
    id: `google-drive:${file.id}`,
    connectorId: connector.id,
    source: 'google-drive',
    kind: 'file',
    repository: file.parents?.[0],
    title: file.name,
    url: file.url,
    updatedAt: file.updatedAt,
    text: [`Drive file: ${file.name}`, file.mimeType ? `MIME: ${file.mimeType}` : undefined, file.text].filter(Boolean).join('\n\n'),
    metadata: { id: file.id, mimeType: file.mimeType, parents: file.parents ?? [] },
  };
}

function gmailMessageDocument(connector: ConnectorRecord, message: GmailMessage): ConnectorDocument {
  return {
    id: `gmail:${message.id}`,
    connectorId: connector.id,
    source: 'gmail',
    kind: 'file',
    repository: message.threadId,
    title: message.subject || message.id,
    url: message.url,
    updatedAt: message.updatedAt,
    text: [`Subject: ${message.subject ?? message.id}`, message.from ? `From: ${message.from}` : undefined, message.snippet, message.text].filter(Boolean).join('\n\n'),
    metadata: { id: message.id, threadId: message.threadId, from: message.from },
  };
}

function googleClient(root: string, token: string, options?: GoogleTokenClientOptions) {
  const fetcher = options?.fetchImpl ?? fetch;
  const apiRoot = stripTrailingSlashes(root);
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 30_000);
  const headers = { Authorization: `Bearer ${requireToken(token, 'Google access token')}`, Accept: 'application/json' };
  const get = async (path: string, query?: Record<string, string>): Promise<unknown> => {
    const url = new URL(`${apiRoot}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const res = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Google API GET ${url.pathname} failed: ${res.status} ${res.statusText}`);
    return res.json();
  };
  const getText = async (url: URL): Promise<string> => {
    const res = await fetcher(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Google API GET ${url.pathname} failed: ${res.status} ${res.statusText}`);
    return res.text();
  };
  return { get, getText, root: apiRoot };
}

async function googlePaginate<T>(client: ReturnType<typeof googleClient>, path: string, query: Record<string, string>, rowKey: string): Promise<T[]> {
  const rows: T[] = [];
  let pageToken = '';
  do {
    const data = await client.get(path, { ...query, ...(pageToken ? { pageToken } : {}) }) as Record<string, unknown>;
    const pageRows = Array.isArray(data[rowKey]) ? data[rowKey] as T[] : [];
    rows.push(...pageRows);
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (pageToken && rows.length < 1000);
  return rows;
}

function driveFileFromRow(row: Record<string, unknown>): GoogleDriveFile {
  return {
    id: stringField(row, 'id'),
    name: stringField(row, 'name') || stringField(row, 'id'),
    mimeType: stringField(row, 'mimeType') || undefined,
    url: stringField(row, 'webViewLink') || undefined,
    updatedAt: stringField(row, 'modifiedTime') || undefined,
    parents: Array.isArray(row.parents) ? row.parents.filter((p): p is string => typeof p === 'string') : [],
  };
}

async function driveFileText(client: ReturnType<typeof googleClient>, file: GoogleDriveFile, includeSheets: boolean): Promise<string | undefined> {
  if (!file.id) return undefined;
  if (file.mimeType === 'application/vnd.google-apps.folder') return undefined;
  if (file.mimeType?.startsWith('application/vnd.google-apps.')) {
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet' && !includeSheets) return undefined;
    const mimeType = file.mimeType === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain';
    const url = new URL(`${client.root}/files/${encodeURIComponent(file.id)}/export`);
    url.searchParams.set('mimeType', mimeType);
    return truncateText(await client.getText(url));
  }
  if (!isTextLikeMime(file.mimeType)) return undefined;
  const url = new URL(`${client.root}/files/${encodeURIComponent(file.id)}`);
  url.searchParams.set('alt', 'media');
  return truncateText(await client.getText(url));
}

function gmailMessageFromRow(row: Record<string, unknown>): GmailMessage {
  const payload = record(row.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(record) : [];
  const header = (name: string) => stringField(headers.find((h) => stringField(h, 'name').toLowerCase() === name.toLowerCase()) ?? {}, 'value');
  const internalDate = stringField(row, 'internalDate');
  const id = stringField(row, 'id');
  return {
    id,
    threadId: stringField(row, 'threadId') || undefined,
    subject: header('Subject') || undefined,
    from: header('From') || undefined,
    url: id ? `https://mail.google.com/mail/u/0/#all/${id}` : undefined,
    updatedAt: internalDate && Number.isFinite(Number(internalDate)) ? new Date(Number(internalDate)).toISOString() : undefined,
    snippet: stringField(row, 'snippet') || undefined,
    text: truncateText(gmailPayloadText(payload)),
  };
}

function gmailPayloadText(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  const walk = (part: Record<string, unknown>): void => {
    const mimeType = stringField(part, 'mimeType');
    const body = record(part.body);
    const data = stringField(body, 'data');
    if (data && (mimeType === 'text/plain' || mimeType === 'text/html' || !mimeType)) chunks.push(decodeBase64Url(data));
    const parts = Array.isArray(part.parts) ? part.parts.map(record) : [];
    for (const child of parts) walk(child);
  };
  walk(payload);
  return chunks.map(htmlToText).filter(Boolean).join('\n\n');
}

function result(documents: ConnectorDocument[], failures: string[], now: string, checkpoint: ConnectorCheckpoint): GoogleConnectorRunResult {
  return {
    documents,
    failures,
    checkpoint: { ...checkpoint, completedAt: now, documentCount: documents.length, failureCount: failures.length },
  };
}

function checkpointHighWatermark(connector: ConnectorRecord): string | undefined {
  return typeof connector.checkpoint?.highWatermark === 'string' ? connector.checkpoint.highWatermark : undefined;
}

function maxIso(values: Array<string | undefined>): string | undefined {
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

function configString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function configStringList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => item.trim()).filter(Boolean);
}

function safeLimit(value: number | undefined, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value ?? 100)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function requireToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function isTextLikeMime(value?: string): boolean {
  return !!value && (value.startsWith('text/') || /(?:json|xml|yaml|csv|markdown|javascript|typescript)$/i.test(value));
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function truncateText(value: string): string {
  return value.length > 200_000 ? `${value.slice(0, 200_000)}\n[truncated]` : value;
}

function htmlToText(value: string): string {
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
