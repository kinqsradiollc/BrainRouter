import type { ConnectorDocument, ConnectorRecord } from '@kinqs/brainrouter-types';
import type {
  ApiConnectorRunOptions,
  ApiConnectorRunResult,
  JiraConnectorClient,
  JiraConnectorIssue,
  TokenClientOptions,
} from './types.js';
import {
  apiResult,
  checkpointHighWatermark,
  commentsText,
  configString,
  configStringList,
  maxIso,
  record,
  requireToken,
  richText,
  safeMaxItems,
  stringField,
  stripTrailing,
  tokenJsonClient,
} from './shared.js';

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
