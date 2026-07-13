import type {
  ConnectorCheckpoint,
  ConnectorDocument,
  ConnectorRecord,
} from '@kinqs/brainrouter-types';

export interface GitlabConnectorIssue {
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  url?: string;
  updatedAt?: string;
  labels?: string[];
  assignees?: Array<{ username?: string }>;
}

export interface GitlabConnectorMergeRequest {
  iid: number;
  title: string;
  description?: string | null;
  state?: string;
  url?: string;
  updatedAt?: string;
  author?: { username?: string };
}

export interface GitlabConnectorClient {
  listProjects(owner: string, opts?: { limit?: number }): Promise<string[]>;
  listIssues(project: string, opts?: { since?: string }): Promise<GitlabConnectorIssue[]>;
  listMergeRequests(project: string, opts?: { since?: string }): Promise<GitlabConnectorMergeRequest[]>;
}

export interface GitlabConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface GitlabConnectorRunOptions {
  now?: string;
  maxProjects?: number;
}

export const GITLAB_PAGE_SIZE = 100;

export async function runGitlabConnectorCheckpoint(
  connector: ConnectorRecord,
  client: GitlabConnectorClient,
  options?: GitlabConnectorRunOptions,
): Promise<GitlabConnectorRunResult> {
  if (connector.source !== 'gitlab') throw new Error(`Connector source ${connector.source} is not gitlab.`);
  const owner = configString(connector, 'owner');
  const configuredProjects = configStringList(connector, 'projects');
  if (!owner && configuredProjects.length === 0) throw new Error('GitLab connector owner or project selection is required.');
  const includeIssues = connector.config.includeIssues !== false;
  const includeMergeRequests = connector.config.includeMergeRequests !== false;
  if (!includeIssues && !includeMergeRequests) {
    throw new Error('GitLab connector must include at least one content type.');
  }

  const since = typeof connector.checkpoint?.highWatermark === 'string' ? connector.checkpoint.highWatermark : undefined;
  const now = options?.now ?? new Date().toISOString();
  const failures: string[] = [];
  const documents: ConnectorDocument[] = [];
  if (connector.config.includeFiles === true) {
    failures.push('files: GitLab file ingestion is not implemented in this runtime; set includeFiles to false.');
  }
  const projects = await resolveProjects(connector, client, owner, options?.maxProjects ?? 100);

  for (const project of projects) {
    if (includeIssues) {
      try {
        const issues = await client.listIssues(project, { since });
        documents.push(...issues.map((issue) => issueDocument(connector, project, issue)));
        if (issues.length >= GITLAB_PAGE_SIZE) failures.push(`${project} issues: results truncated at ${GITLAB_PAGE_SIZE}.`);
      } catch (err) {
        failures.push(`${project} issues: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (includeMergeRequests) {
      try {
        const mergeRequests = await client.listMergeRequests(project, { since });
        documents.push(...mergeRequests.map((mergeRequest) => mergeRequestDocument(connector, project, mergeRequest)));
        if (mergeRequests.length >= GITLAB_PAGE_SIZE) failures.push(`${project} merge requests: results truncated at ${GITLAB_PAGE_SIZE}.`);
      } catch (err) {
        failures.push(`${project} merge requests: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const highWatermark = maxIso([since, ...documents.map((doc) => doc.updatedAt), now]);
  return {
    documents,
    failures,
    checkpoint: {
      highWatermark,
      projects,
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
    },
  };
}

export interface GitlabTokenClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  authMode?: 'private-token' | 'bearer';
}

export function gitlabTokenClient(token: string, baseUrl?: string, options?: GitlabTokenClientOptions): GitlabConnectorClient {
  const trimmedToken = token.trim();
  if (!trimmedToken) throw new Error('GitLab token is required.');
  const apiRoot = `${(baseUrl?.trim() || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`;
  const fetcher = options?.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 30_000);

  async function requestJson(pathAndQuery: string): Promise<unknown> {
    const res = await fetcher(`${apiRoot}${pathAndQuery}`, {
      headers: { ...(options?.authMode === 'bearer' ? { Authorization: `Bearer ${trimmedToken}` } : { 'PRIVATE-TOKEN': trimmedToken }), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GitLab API ${res.status} ${res.statusText} for ${pathAndQuery}`);
    return res.json();
  }

  return {
    // Single page per listing (per_page=100); the runtime records a truncated
    // failure note when a listing comes back full.
    async listProjects(owner, opts) {
      const limit = Math.max(1, opts?.limit ?? GITLAB_PAGE_SIZE);
      const encoded = encodeURIComponent(owner.trim());
      let rows: unknown;
      try {
        rows = await requestJson(`/groups/${encoded}/projects?per_page=${GITLAB_PAGE_SIZE}&order_by=last_activity_at&include_subgroups=true`);
      } catch {
        rows = await requestJson(`/users/${encoded}/projects?per_page=${GITLAB_PAGE_SIZE}&order_by=last_activity_at`);
      }
      return asRows(rows)
        .map((row) => rowString(row, 'path_with_namespace'))
        .filter((value): value is string => !!value)
        .slice(0, limit);
    },
    async listIssues(project, opts) {
      const query = withSince(`per_page=${GITLAB_PAGE_SIZE}&order_by=updated_at&sort=asc&state=all&scope=all`, opts?.since);
      const rows = await requestJson(`/projects/${encodeURIComponent(project)}/issues?${query}`);
      return asRows(rows).map(mapIssueRow);
    },
    async listMergeRequests(project, opts) {
      const query = withSince(`per_page=${GITLAB_PAGE_SIZE}&order_by=updated_at&sort=asc&state=all&scope=all`, opts?.since);
      const rows = await requestJson(`/projects/${encodeURIComponent(project)}/merge_requests?${query}`);
      return asRows(rows).map(mapMergeRequestRow);
    },
  };
}

async function resolveProjects(
  connector: ConnectorRecord,
  client: Pick<GitlabConnectorClient, 'listProjects'>,
  owner: string | undefined,
  maxProjects: number,
): Promise<string[]> {
  const configured = configStringList(connector, 'projects');
  const projects = configured.length
    ? configured.map((project) => project.includes('/') || !owner ? project : `${owner}/${project}`)
    : await client.listProjects(owner!, { limit: maxProjects });
  const unique: string[] = [];
  for (const project of projects) {
    const trimmed = project.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique.slice(0, maxProjects);
}

function issueDocument(connector: ConnectorRecord, project: string, issue: GitlabConnectorIssue): ConnectorDocument {
  const labels = (issue.labels ?? []).filter((label) => typeof label === 'string' && label.trim().length > 0).map((label) => label.trim());
  const assignees = (issue.assignees ?? []).map((assignee) => assignee.username ?? '').filter(Boolean);
  const title = `#${issue.iid} ${issue.title}`;
  return {
    id: `gitlab:${project}:issue:${issue.iid}`,
    connectorId: connector.id,
    source: 'gitlab',
    kind: 'issue',
    repository: project,
    title,
    url: issue.url,
    updatedAt: issue.updatedAt,
    text: [`Issue ${title}`, issue.state ? `State: ${issue.state}` : undefined, labels.length ? `Labels: ${labels.join(', ')}` : undefined, assignees.length ? `Assignees: ${assignees.join(', ')}` : undefined, issue.description ?? undefined].filter(Boolean).join('\n\n'),
    metadata: { iid: issue.iid, state: issue.state, labels, assignees },
  };
}

function mergeRequestDocument(connector: ConnectorRecord, project: string, mergeRequest: GitlabConnectorMergeRequest): ConnectorDocument {
  const title = `!${mergeRequest.iid} ${mergeRequest.title}`;
  return {
    id: `gitlab:${project}:merge-request:${mergeRequest.iid}`,
    connectorId: connector.id,
    source: 'gitlab',
    kind: 'pull-request',
    repository: project,
    title,
    url: mergeRequest.url,
    updatedAt: mergeRequest.updatedAt,
    text: [`Merge request ${title}`, mergeRequest.state ? `State: ${mergeRequest.state}` : undefined, mergeRequest.author?.username ? `Author: ${mergeRequest.author.username}` : undefined, mergeRequest.description ?? undefined].filter(Boolean).join('\n\n'),
    metadata: { iid: mergeRequest.iid, state: mergeRequest.state, author: mergeRequest.author?.username },
  };
}

type JsonRecord = Record<string, unknown>;

function asRows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((row): row is JsonRecord => !!row && typeof row === 'object') : [];
}

function rowString(row: JsonRecord, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function mapIssueRow(row: JsonRecord): GitlabConnectorIssue {
  return {
    iid: Number(row.iid ?? 0),
    title: rowString(row, 'title') ?? '',
    description: rowString(row, 'description'),
    state: rowString(row, 'state'),
    url: rowString(row, 'web_url'),
    updatedAt: rowString(row, 'updated_at'),
    labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : undefined,
    assignees: Array.isArray(row.assignees)
      ? row.assignees.map((assignee) => ({ username: typeof (assignee as JsonRecord)?.username === 'string' ? (assignee as JsonRecord).username as string : undefined }))
      : undefined,
  };
}

function mapMergeRequestRow(row: JsonRecord): GitlabConnectorMergeRequest {
  const author = row.author && typeof row.author === 'object' ? row.author as JsonRecord : undefined;
  return {
    iid: Number(row.iid ?? 0),
    title: rowString(row, 'title') ?? '',
    description: rowString(row, 'description'),
    state: rowString(row, 'state'),
    url: rowString(row, 'web_url'),
    updatedAt: rowString(row, 'updated_at'),
    author: author ? { username: rowString(author, 'username') } : undefined,
  };
}

function withSince(query: string, since?: string): string {
  return since ? `${query}&updated_after=${encodeURIComponent(since)}` : query;
}

function configString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function configStringList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}

function maxIso(values: Array<string | undefined>): string {
  const valid = values.filter((value): value is string => !!value && !Number.isNaN(new Date(value).getTime()));
  if (valid.length === 0) return new Date().toISOString();
  return valid.sort((a, b) => a.localeCompare(b))[valid.length - 1];
}
