import type { ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type {
  ApiConnectorRunOptions,
  ApiConnectorRunResult,
  LinearConnectorClient,
  LinearConnectorIssue,
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
