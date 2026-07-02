import type { ConnectorCheckpoint, ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';

export interface SlackConnectorChannel {
  id: string;
  name: string;
}

export interface SlackConnectorMessage {
  channelId: string;
  channelName?: string;
  ts: string;
  text?: string;
  user?: string;
  permalink?: string;
  threadTs?: string;
  replies?: SlackConnectorMessage[];
}

export interface SlackConnectorClient {
  listChannels(opts?: { include?: string[]; exclude?: string[]; limit?: number }): Promise<SlackConnectorChannel[]>;
  listMessages(channel: SlackConnectorChannel, opts?: { since?: string; includeThreads?: boolean; includeBotMessages?: boolean }): Promise<SlackConnectorMessage[]>;
}

export interface JiraConnectorIssue {
  key: string;
  summary: string;
  description?: string;
  status?: string;
  url?: string;
  updatedAt?: string;
  labels?: string[];
  assignee?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface JiraConnectorClient {
  listIssues(opts: { projects: string[]; jql?: string; since?: string; includeComments?: boolean }): Promise<JiraConnectorIssue[]>;
}

export interface ConfluenceConnectorPage {
  id: string;
  title: string;
  space?: string;
  url?: string;
  updatedAt?: string;
  body?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface ConfluenceConnectorClient {
  listPages(opts: { spaces: string[]; since?: string; includeComments?: boolean }): Promise<ConfluenceConnectorPage[]>;
}

export interface NotionConnectorPage {
  id: string;
  title: string;
  url?: string;
  updatedAt?: string;
  parent?: string;
  body?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface NotionConnectorClient {
  listPages(opts: { databaseIds: string[]; since?: string; includeComments?: boolean }): Promise<NotionConnectorPage[]>;
}

export interface LinearConnectorIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  state?: string;
  url?: string;
  updatedAt?: string;
  teamKey?: string;
  assignee?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface LinearConnectorClient {
  listIssues(opts: { teamKeys: string[]; since?: string; includeArchived?: boolean; includeComments?: boolean }): Promise<LinearConnectorIssue[]>;
}

export interface ApiConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface ApiConnectorRunOptions {
  now?: string;
  maxItems?: number;
}

export async function runSlackConnectorCheckpoint(
  connector: ConnectorRecord,
  client: SlackConnectorClient,
  options?: ApiConnectorRunOptions,
): Promise<ApiConnectorRunResult> {
  if (connector.source !== 'slack') throw new Error(`Connector source ${connector.source} is not slack.`);
  const include = configStringList(connector, 'channels');
  const exclude = configStringList(connector, 'excludeChannels');
  const includeThreads = connector.config.includeThreads !== false;
  const includeBotMessages = connector.config.includeBotMessages === true;
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const maxItems = safeMaxItems(options?.maxItems);
  const failures: string[] = [];
  const documents: ConnectorDocument[] = [];
  let channels: SlackConnectorChannel[] = [];
  try {
    channels = await client.listChannels({ include, exclude, limit: 200 });
  } catch (err) {
    throw new Error(`Slack channel discovery failed: ${errorText(err)}`);
  }
  for (const channel of channels) {
    if (documents.length >= maxItems) break;
    try {
      const messages = await client.listMessages(channel, { since, includeThreads, includeBotMessages });
      for (const message of messages) {
        if (!includeBotMessages && !message.user) continue;
        documents.push(slackMessageDocument(connector, channel, message));
        for (const reply of message.replies ?? []) {
          if (documents.length >= maxItems) break;
          if (!includeBotMessages && !reply.user) continue;
          documents.push(slackMessageDocument(connector, channel, { ...reply, threadTs: message.ts }));
        }
        if (documents.length >= maxItems) break;
      }
    } catch (err) {
      failures.push(`${channel.name || channel.id}: ${errorText(err)}`);
    }
  }
  if (documents.length >= maxItems) failures.push(`Stopped after ${maxItems} Slack messages.`);
  return apiResult(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), channels: channels.map((c) => c.name || c.id) });
}

export async function runJiraConnectorCheckpoint(
  connector: ConnectorRecord,
  client: JiraConnectorClient,
  options?: ApiConnectorRunOptions,
): Promise<ApiConnectorRunResult> {
  if (connector.source !== 'jira') throw new Error(`Connector source ${connector.source} is not jira.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const issues = await client.listIssues({
    projects: configStringList(connector, 'projects'),
    jql: configString(connector, 'jql'),
    since,
    includeComments: connector.config.includeComments !== false,
  });
  const maxItems = safeMaxItems(options?.maxItems);
  const documents = issues.slice(0, maxItems).map((issue) => jiraIssueDocument(connector, issue));
  const failures = issues.length > maxItems ? [`Stopped after ${maxItems} Jira issues.`] : [];
  return apiResult(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), issueCount: documents.length });
}

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

export async function runLinearConnectorCheckpoint(
  connector: ConnectorRecord,
  client: LinearConnectorClient,
  options?: ApiConnectorRunOptions,
): Promise<ApiConnectorRunResult> {
  if (connector.source !== 'linear') throw new Error(`Connector source ${connector.source} is not linear.`);
  const since = checkpointHighWatermark(connector);
  const now = options?.now ?? new Date().toISOString();
  const issues = await client.listIssues({
    teamKeys: configStringList(connector, 'teamKeys'),
    since,
    includeArchived: connector.config.includeArchived === true,
    includeComments: connector.config.includeComments !== false,
  });
  const maxItems = safeMaxItems(options?.maxItems);
  const documents = issues.slice(0, maxItems).map((issue) => linearIssueDocument(connector, issue));
  const failures = issues.length > maxItems ? [`Stopped after ${maxItems} Linear issues.`] : [];
  return apiResult(documents, failures, now, { highWatermark: maxIso([since, ...documents.map((doc) => doc.updatedAt), now]), issueCount: documents.length });
}

export interface TokenClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function slackTokenClient(token: string, options?: TokenClientOptions): SlackConnectorClient {
  const client = tokenJsonClient('https://slack.com/api', { Authorization: `Bearer ${requireToken(token, 'Slack token')}` }, options);
  return {
    async listChannels(opts) {
      const rows = await slackPaginate<{ id?: string; name?: string }>(client, '/conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
      });
      const include = new Set((opts?.include ?? []).map((v) => v.trim()).filter(Boolean));
      const exclude = new Set((opts?.exclude ?? []).map((v) => v.trim()).filter(Boolean));
      return rows
        .map((row) => ({ id: row.id ?? '', name: row.name ?? '' }))
        .filter((row) => row.id && (!include.size || include.has(row.id) || include.has(row.name)) && !exclude.has(row.id) && !exclude.has(row.name))
        .slice(0, opts?.limit ?? 200);
    },
    async listMessages(channel, opts) {
      const rows = await slackPaginate<Record<string, unknown>>(client, '/conversations.history', {
        channel: channel.id,
        limit: '100',
        ...(opts?.since ? { oldest: String(Date.parse(opts.since) / 1000) } : {}),
      }, 'messages');
      const messages: SlackConnectorMessage[] = [];
      for (const row of rows) {
        const message = slackMessageFromRow(channel, row);
        const replyCount = typeof row.reply_count === 'number' ? row.reply_count : Number(row.reply_count ?? 0);
        if (opts?.includeThreads && message.ts && (message.threadTs ?? message.ts) === message.ts && replyCount > 0) {
          const replies = await slackPaginate<Record<string, unknown>>(client, '/conversations.replies', {
            channel: channel.id,
            ts: message.ts,
            limit: '100',
          }, 'messages');
          message.replies = replies
            .map((reply) => slackMessageFromRow(channel, reply))
            .filter((reply) => reply.ts && reply.ts !== message.ts);
        }
        messages.push(message);
      }
      return messages;
    },
  };
}

export function jiraTokenClient(token: string, baseUrl: string, options?: TokenClientOptions): JiraConnectorClient {
  const root = stripTrailing(baseUrl || '').replace(/\/rest\/api\/\d+$/, '');
  const client = tokenJsonClient(`${root}/rest/api/3`, { Authorization: `Bearer ${requireToken(token, 'Jira token')}` }, options);
  return {
    async listIssues(opts) {
      const clauses = [
        opts.jql?.trim(),
        opts.projects.length ? `project in (${opts.projects.map((p) => JSON.stringify(p)).join(',')})` : '',
        opts.since ? `updated >= "${opts.since.slice(0, 10)}"` : '',
      ].filter(Boolean);
      const data = await client.get('/search', {
        jql: clauses.join(' AND ') || 'ORDER BY updated DESC',
        maxResults: '100',
        fields: 'summary,description,status,labels,assignee,updated,comment',
      }) as { issues?: Array<Record<string, unknown>> };
      return (data.issues ?? []).map((row) => jiraIssueFromRow(root, row));
    },
  };
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

export function linearTokenClient(token: string, options?: TokenClientOptions): LinearConnectorClient {
  const client = tokenJsonClient('https://api.linear.app', { Authorization: requireToken(token, 'Linear token') }, options);
  return {
    async listIssues(opts) {
      const filter: Record<string, unknown> = {};
      if (opts.teamKeys.length) filter.team = { key: { in: opts.teamKeys } };
      if (opts.since) filter.updatedAt = { gt: opts.since };
      if (!opts.includeArchived) filter.archivedAt = { null: true };
      const data = await client.post('/graphql', {
        query: `query BrainRouterIssues($filter: IssueFilter) {
          issues(first: 100, filter: $filter, orderBy: updatedAt) {
            nodes {
              id identifier title description url updatedAt
              state { name }
              team { key }
              assignee { name email }
              comments(first: 20) { nodes { body updatedAt user { name email } } }
            }
          }
        }`,
        variables: { filter },
      }) as { data?: { issues?: { nodes?: Array<Record<string, unknown>> } } };
      return (data.data?.issues?.nodes ?? []).map(linearIssueFromRow);
    },
  };
}

function slackMessageDocument(connector: ConnectorRecord, channel: SlackConnectorChannel, message: SlackConnectorMessage): ConnectorDocument {
  const channelName = message.channelName || channel.name || message.channelId || channel.id;
  const updatedAt = slackTsToIso(message.ts);
  return {
    id: `slack:${connector.id}:${channel.id}:${message.ts}`,
    connectorId: connector.id,
    source: 'slack',
    kind: 'file',
    repository: channelName,
    title: `${channelName} ${updatedAt ?? message.ts}`,
    url: message.permalink,
    updatedAt,
    text: [`Channel: ${channelName}`, message.user ? `User: ${message.user}` : undefined, message.text ?? ''].filter(Boolean).join('\n\n'),
    metadata: { channelId: channel.id, channelName, ts: message.ts, user: message.user, threadTs: message.threadTs },
  };
}

function jiraIssueDocument(connector: ConnectorRecord, issue: JiraConnectorIssue): ConnectorDocument {
  return {
    id: `jira:${issue.key}`,
    connectorId: connector.id,
    source: 'jira',
    kind: 'issue',
    repository: issue.key.split('-')[0],
    title: `${issue.key} ${issue.summary}`,
    url: issue.url,
    updatedAt: issue.updatedAt,
    text: [`Issue ${issue.key}`, issue.status ? `Status: ${issue.status}` : undefined, issue.labels?.length ? `Labels: ${issue.labels.join(', ')}` : undefined, issue.assignee ? `Assignee: ${issue.assignee}` : undefined, issue.description, commentsText(issue.comments)].filter(Boolean).join('\n\n'),
    metadata: { key: issue.key, status: issue.status, labels: issue.labels ?? [], assignee: issue.assignee },
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

function linearIssueDocument(connector: ConnectorRecord, issue: LinearConnectorIssue): ConnectorDocument {
  const key = issue.identifier || issue.id;
  return {
    id: `linear:${issue.id}`,
    connectorId: connector.id,
    source: 'linear',
    kind: 'issue',
    repository: issue.teamKey,
    title: `${key} ${issue.title}`,
    url: issue.url,
    updatedAt: issue.updatedAt,
    text: [`Issue ${key}`, issue.state ? `State: ${issue.state}` : undefined, issue.assignee ? `Assignee: ${issue.assignee}` : undefined, issue.description, commentsText(issue.comments)].filter(Boolean).join('\n\n'),
    metadata: { id: issue.id, identifier: issue.identifier, state: issue.state, teamKey: issue.teamKey, assignee: issue.assignee },
  };
}

function apiResult(documents: ConnectorDocument[], failures: string[], now: string, checkpoint: ConnectorCheckpoint): ApiConnectorRunResult {
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

function tokenJsonClient(root: string, headers: Record<string, string>, options?: TokenClientOptions) {
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

async function slackPaginate<T>(client: ReturnType<typeof tokenJsonClient>, path: string, query: Record<string, string>, rowKey = 'channels'): Promise<T[]> {
  const rows: T[] = [];
  let cursor = '';
  do {
    const data = await client.get(path, { ...query, ...(cursor ? { cursor } : {}) }) as Record<string, unknown>;
    if (data.ok === false) throw new Error(typeof data.error === 'string' ? data.error : 'Slack API returned ok=false.');
    const pageRows = Array.isArray(data[rowKey]) ? data[rowKey] as T[] : [];
    rows.push(...pageRows);
    const meta = data.response_metadata && typeof data.response_metadata === 'object' ? data.response_metadata as Record<string, unknown> : {};
    cursor = typeof meta.next_cursor === 'string' ? meta.next_cursor : '';
  } while (cursor && rows.length < 1000);
  return rows;
}

function slackMessageFromRow(channel: SlackConnectorChannel, row: Record<string, unknown>): SlackConnectorMessage {
  return {
    channelId: channel.id,
    channelName: channel.name,
    ts: typeof row.ts === 'string' ? row.ts : '',
    text: typeof row.text === 'string' ? row.text : '',
    user: typeof row.user === 'string' ? row.user : undefined,
    threadTs: typeof row.thread_ts === 'string' ? row.thread_ts : undefined,
  };
}

function jiraIssueFromRow(root: string, row: Record<string, unknown>): JiraConnectorIssue {
  const fields = record(row.fields);
  const comment = record(fields.comment);
  const comments = Array.isArray(comment.comments)
    ? comment.comments.map((c) => jiraCommentFromRow(record(c))).filter((c): c is NonNullable<JiraConnectorIssue['comments']>[number] => !!c)
    : [];
  return {
    key: stringField(row, 'key'),
    summary: stringField(fields, 'summary'),
    description: richText(fields.description),
    status: stringField(record(fields.status), 'name') || undefined,
    url: `${root}/browse/${stringField(row, 'key')}`,
    updatedAt: stringField(fields, 'updated') || undefined,
    labels: Array.isArray(fields.labels) ? fields.labels.filter((v): v is string => typeof v === 'string') : [],
    assignee: stringField(record(fields.assignee), 'displayName') || undefined,
    comments,
  };
}

function jiraCommentFromRow(row: Record<string, unknown>): NonNullable<JiraConnectorIssue['comments']>[number] | undefined {
  const body = richText(row.body);
  if (!body) return undefined;
  return { body, author: stringField(record(row.author), 'displayName') || undefined, updatedAt: stringField(row, 'updated') || undefined };
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

function linearIssueFromRow(row: Record<string, unknown>): LinearConnectorIssue {
  const nodes = record(row.comments).nodes;
  const commentRows = Array.isArray(nodes) ? nodes : [];
  return {
    id: stringField(row, 'id'),
    identifier: stringField(row, 'identifier') || undefined,
    title: stringField(row, 'title'),
    description: stringField(row, 'description') || undefined,
    state: stringField(record(row.state), 'name') || undefined,
    url: stringField(row, 'url') || undefined,
    updatedAt: stringField(row, 'updatedAt') || undefined,
    teamKey: stringField(record(row.team), 'key') || undefined,
    assignee: stringField(record(row.assignee), 'name') || stringField(record(row.assignee), 'email') || undefined,
    comments: commentRows.map((c) => {
      const comment = record(c);
      return { body: stringField(comment, 'body'), author: stringField(record(comment.user), 'name') || stringField(record(comment.user), 'email') || undefined, updatedAt: stringField(comment, 'updatedAt') || undefined };
    }).filter((c) => c.body),
  };
}

function notionTitle(prop: Record<string, unknown>): string {
  const title = Array.isArray(prop.title) ? prop.title : Array.isArray(prop.rich_text) ? prop.rich_text : [];
  return notionRichText(title);
}

function commentsText(comments?: Array<{ author?: string; body: string; updatedAt?: string }>): string | undefined {
  if (!comments?.length) return undefined;
  return comments.map((comment) => [`Comment${comment.author ? ` by ${comment.author}` : ''}${comment.updatedAt ? ` at ${comment.updatedAt}` : ''}`, comment.body].join('\n')).join('\n\n');
}

function confluenceApiRoot(baseUrl: string): string {
  const base = stripTrailing(baseUrl);
  if (base.endsWith('/rest/api') || base.endsWith('/wiki/rest/api')) return base;
  if (/\.atlassian\.net$/i.test(new URL(base).hostname)) return `${base}/wiki/rest/api`;
  return `${base}/rest/api`;
}

function richText(value: unknown): string {
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

function slackTsToIso(ts: string): string | undefined {
  const seconds = Number(ts.split('.')[0]);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
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

function safeMaxItems(value: number | undefined): number {
  return Math.max(1, Math.min(1000, Math.floor(value ?? 200)));
}

function requireToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function stripTrailing(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Connector base URL is required.');
  return trimmed.replace(/\/+$/, '');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
