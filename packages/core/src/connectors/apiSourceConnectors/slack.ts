import type { ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type {
  ApiConnectorRunOptions,
  ApiConnectorRunResult,
  SlackConnectorChannel,
  SlackConnectorClient,
  SlackConnectorMessage,
  TokenClientOptions,
} from './types.js';
import {
  apiResult,
  checkpointHighWatermark,
  configStringList,
  errorText,
  maxIso,
  requireToken,
  safeMaxItems,
  slackTsToIso,
  tokenJsonClient,
} from './shared.js';

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
