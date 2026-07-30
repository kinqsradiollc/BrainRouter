import type { ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type {
  ApiConnectorRunOptions,
  ApiConnectorRunResult,
  NotionConnectorClient,
  NotionConnectorPage,
  TokenClientOptions,
} from './types.js';
import {
  apiResult,
  checkpointHighWatermark,
  commentsText,
  configStringList,
  maxIso,
  record,
  requireToken,
  safeMaxItems,
  stringField,
  tokenJsonClient,
} from './shared.js';

export async function runNotionConnectorCheckpoint(
  connector: ConnectorRecord,
  client: NotionConnectorClient,
  options?: ApiConnectorRunOptions,
): Promise<ApiConnectorRunResult> {
  if (connector.source !== 'notion') throw new Error(`Connector source ${connector.source} is not notion.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const pages = await client.listPages({
    databaseIds: configStringList(connector, 'databaseIds'),
    since,
    includeComments: connector.config.includeComments === true,
  });
  const maxItems = safeMaxItems(options?.maxItems);
  const documents = pages.slice(0, maxItems).map((page) => notionPageDocument(connector, page));
  const failures = pages.length > maxItems ? [`Stopped after ${maxItems} Notion pages.`] : [];
  return apiResult(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), pageCount: documents.length });
}

export function notionTokenClient(token: string, options?: TokenClientOptions & { notionVersion?: string }): NotionConnectorClient {
  const client = tokenJsonClient('https://api.notion.com/v1', {
    Authorization: `Bearer ${requireToken(token, 'Notion token')}`,
    'Notion-Version': options?.notionVersion ?? '2022-06-28',
  }, options);
  return {
    async listPages(opts) {
      if (opts.databaseIds.length) {
        const pages: NotionConnectorPage[] = [];
        for (const databaseId of opts.databaseIds) {
          const data = await client.post(`/databases/${encodeURIComponent(databaseId)}/query`, {
            page_size: 100,
            ...(opts.since ? { filter: { timestamp: 'last_edited_time', last_edited_time: { after: opts.since } } } : {}),
          }) as { results?: Array<Record<string, unknown>> };
          pages.push(...await enrichNotionPages(client, (data.results ?? []).map(notionPageFromRow), opts.includeComments === true));
        }
        return pages;
      }
      const data = await client.post('/search', {
        page_size: 100,
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      }) as { results?: Array<Record<string, unknown>> };
      const pages = (data.results ?? []).map(notionPageFromRow).filter((page) => !opts.since || !page.updatedAt || page.updatedAt > opts.since!);
      return enrichNotionPages(client, pages, opts.includeComments === true);
    },
  };
}

function notionPageDocument(connector: ConnectorRecord, page: NotionConnectorPage): ConnectorDocument {
  return {
    id: `notion:${page.id}`,
    connectorId: connector.id,
    source: 'notion',
    kind: 'file',
    repository: page.parent,
    title: page.title,
    url: page.url,
    updatedAt: page.updatedAt,
    text: [`Page: ${page.title}`, page.body, commentsText(page.comments)].filter(Boolean).join('\n\n'),
    metadata: { id: page.id, parent: page.parent },
  };
}

function notionPageFromRow(row: Record<string, unknown>): NotionConnectorPage {
  const props = record(row.properties);
  const title = Object.values(props).map((value) => notionTitle(record(value))).find(Boolean) || stringField(row, 'id');
  return {
    id: stringField(row, 'id'),
    title,
    url: stringField(row, 'url') || undefined,
    updatedAt: stringField(row, 'last_edited_time') || undefined,
    parent: Object.values(record(row.parent)).find((value): value is string => typeof value === 'string') || undefined,
  };
}

async function enrichNotionPages(client: ReturnType<typeof tokenJsonClient>, pages: NotionConnectorPage[], includeComments: boolean): Promise<NotionConnectorPage[]> {
  const enriched: NotionConnectorPage[] = [];
  for (const page of pages) {
    const [body, comments] = await Promise.all([
      notionBlockChildrenText(client, page.id),
      includeComments ? notionComments(client, page.id) : Promise.resolve(undefined),
    ]);
    enriched.push({ ...page, body: body || page.body, comments });
  }
  return enriched;
}

async function notionBlockChildrenText(client: ReturnType<typeof tokenJsonClient>, blockId: string, depth = 0): Promise<string> {
  const chunks: string[] = [];
  let cursor = '';
  do {
    const data = await client.get(`/blocks/${encodeURIComponent(blockId)}/children`, {
      page_size: '100',
      ...(cursor ? { start_cursor: cursor } : {}),
    }) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
    for (const row of data.results ?? []) {
      const text = notionBlockText(row);
      if (text) chunks.push(text);
      if (row.has_children === true && depth < 1) {
        const childText = await notionBlockChildrenText(client, stringField(row, 'id'), depth + 1);
        if (childText) chunks.push(childText);
      }
    }
    cursor = data.has_more && typeof data.next_cursor === 'string' ? data.next_cursor : '';
  } while (cursor);
  return chunks.join('\n\n');
}

async function notionComments(client: ReturnType<typeof tokenJsonClient>, blockId: string): Promise<NonNullable<NotionConnectorPage['comments']>> {
  const rows: Record<string, unknown>[] = [];
  let cursor = '';
  do {
    const data = await client.get('/comments', {
      block_id: blockId,
      page_size: '100',
      ...(cursor ? { start_cursor: cursor } : {}),
    }) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
    rows.push(...(data.results ?? []));
    cursor = data.has_more && typeof data.next_cursor === 'string' ? data.next_cursor : '';
  } while (cursor);
  return rows.map(notionCommentFromRow).filter((comment): comment is NonNullable<NotionConnectorPage['comments']>[number] => !!comment);
}

function notionCommentFromRow(row: Record<string, unknown>): NonNullable<NotionConnectorPage['comments']>[number] | undefined {
  const body = notionRichText(row.rich_text);
  if (!body) return undefined;
  return {
    body,
    author: notionUserName(record(row.created_by)),
    updatedAt: stringField(row, 'last_edited_time') || stringField(row, 'created_time') || undefined,
  };
}

function notionBlockText(row: Record<string, unknown>): string {
  const type = stringField(row, 'type');
  const payload = record(row[type]);
  const parts = [
    notionRichText(payload.rich_text),
    notionRichText(payload.title),
    notionRichText(payload.caption),
    notionTableCells(payload.cells),
  ];
  return parts.filter(Boolean).join('\n');
}

function notionRichText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((part) => stringField(record(part), 'plain_text')).filter(Boolean).join('');
}

function notionTableCells(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((cell) => Array.isArray(cell) ? cell.map((part) => stringField(record(part), 'plain_text')).filter(Boolean).join('') : '')
    .filter(Boolean)
    .join(' | ');
}

function notionUserName(user: Record<string, unknown>): string | undefined {
  if (stringField(user, 'name')) return stringField(user, 'name');
  const person = record(user.person);
  return stringField(person, 'email') || undefined;
}

function notionTitle(prop: Record<string, unknown>): string {
  const title = Array.isArray(prop.title) ? prop.title : Array.isArray(prop.rich_text) ? prop.rich_text : [];
  return notionRichText(title);
}
