import type { ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type {
  ApiConnectorRunOptions,
  ApiConnectorRunResult,
  ConfluenceConnectorClient,
  ConfluenceConnectorPage,
  TokenClientOptions,
} from './types.js';
import {
  apiResult,
  checkpointHighWatermark,
  commentsText,
  configStringList,
  htmlToText,
  maxIso,
  record,
  requireToken,
  safeMaxItems,
  stringField,
  stripTrailing,
  tokenJsonClient,
} from './shared.js';

export async function runConfluenceConnectorCheckpoint(
  connector: ConnectorRecord,
  client: ConfluenceConnectorClient,
  options?: ApiConnectorRunOptions,
): Promise<ApiConnectorRunResult> {
  if (connector.source !== 'confluence') throw new Error(`Connector source ${connector.source} is not confluence.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const pages = await client.listPages({
    spaces: configStringList(connector, 'spaces'),
    since,
    includeComments: connector.config.includeComments !== false,
  });
  const maxItems = safeMaxItems(options?.maxItems);
  const documents = pages.slice(0, maxItems).map((page) => confluencePageDocument(connector, page));
  const failures = pages.length > maxItems ? [`Stopped after ${maxItems} Confluence pages.`] : [];
  return apiResult(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), pageCount: documents.length });
}

export function confluenceTokenClient(token: string, baseUrl: string, options?: TokenClientOptions): ConfluenceConnectorClient {
  const root = confluenceApiRoot(baseUrl);
  const site = root.replace(/\/(?:wiki\/)?rest\/api$/, '');
  const client = tokenJsonClient(root, { Authorization: `Bearer ${requireToken(token, 'Confluence token')}` }, options);
  return {
    async listPages(opts) {
      const spaces = opts.spaces.length ? opts.spaces : [''];
      const pages: ConfluenceConnectorPage[] = [];
      for (const space of spaces) {
        const data = await client.get('/content', {
          type: 'page',
          limit: '100',
          expand: 'body.storage,version,space',
          ...(space ? { spaceKey: space } : {}),
        }) as { results?: Array<Record<string, unknown>> };
        const mapped = (data.results ?? [])
          .map((row) => confluencePageFromRow(site, row))
          .filter((page) => !opts.since || !page.updatedAt || page.updatedAt > opts.since!);
        if (opts.includeComments) {
          for (const page of mapped) {
            const comments = await client.get(`/content/${encodeURIComponent(page.id)}/child/comment`, {
              limit: '100',
              expand: 'body.storage,version,history',
            }) as { results?: Array<Record<string, unknown>> };
            page.comments = (comments.results ?? []).map(confluenceCommentFromRow).filter((comment): comment is NonNullable<ConfluenceConnectorPage['comments']>[number] => !!comment);
          }
        }
        pages.push(...mapped);
      }
      return pages;
    },
  };
}

function confluencePageDocument(connector: ConnectorRecord, page: ConfluenceConnectorPage): ConnectorDocument {
  return {
    id: `confluence:${page.id}`,
    connectorId: connector.id,
    source: 'confluence',
    kind: 'file',
    repository: page.space,
    title: page.title,
    url: page.url,
    updatedAt: page.updatedAt,
    text: [`Page: ${page.title}`, htmlToText(page.body ?? ''), commentsText(page.comments)].filter(Boolean).join('\n\n'),
    metadata: { id: page.id, space: page.space },
  };
}

function confluencePageFromRow(site: string, row: Record<string, unknown>): ConfluenceConnectorPage {
  const body = record(record(row.body).storage);
  const version = record(row.version);
  const links = record(row._links);
  const webui = stringField(links, 'webui');
  return {
    id: stringField(row, 'id'),
    title: stringField(row, 'title'),
    space: stringField(record(row.space), 'key') || undefined,
    url: webui ? `${site}${webui}` : undefined,
    updatedAt: stringField(version, 'when') || undefined,
    body: stringField(body, 'value') || undefined,
  };
}

function confluenceCommentFromRow(row: Record<string, unknown>): NonNullable<ConfluenceConnectorPage['comments']>[number] | undefined {
  const body = htmlToText(stringField(record(record(row.body).storage), 'value'));
  if (!body) return undefined;
  const history = record(row.history);
  const author = record(history.createdBy);
  return {
    body,
    author: stringField(author, 'displayName') || stringField(author, 'publicName') || undefined,
    updatedAt: stringField(record(row.version), 'when') || undefined,
  };
}

function confluenceApiRoot(baseUrl: string): string {
  const base = stripTrailing(baseUrl);
  if (base.endsWith('/rest/api') || base.endsWith('/wiki/rest/api')) return base;
  if (/\.atlassian\.net$/i.test(new URL(base).hostname)) return `${base}/wiki/rest/api`;
  return `${base}/rest/api`;
}
