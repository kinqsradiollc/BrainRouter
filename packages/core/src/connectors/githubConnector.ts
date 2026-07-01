import type {
  ConnectorCheckpoint,
  ConnectorDocument,
  ConnectorPermission,
  ConnectorRecord,
} from '@kinqs/brainrouter-types';

export interface GithubConnectorIssue {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  url?: string;
  updatedAt?: string;
  labels?: Array<string | { name?: string }>;
  assignees?: Array<{ login?: string }>;
}

export interface GithubConnectorPullRequest {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  url?: string;
  updatedAt?: string;
  author?: { login?: string };
}

export interface GithubConnectorFile {
  path: string;
  text?: string;
  size?: number;
  sha?: string;
  url?: string;
  updatedAt?: string;
}

export interface GithubConnectorCollaborator {
  login: string;
  name?: string | null;
  htmlUrl?: string;
  roleName?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

export interface GithubConnectorClient {
  listRepositories(owner: string, opts?: { limit?: number }): Promise<string[]>;
  listIssues(repo: string, opts?: { since?: string }): Promise<GithubConnectorIssue[]>;
  listPullRequests(repo: string, opts?: { since?: string }): Promise<GithubConnectorPullRequest[]>;
  listFiles(repo: string, opts?: { since?: string }): Promise<GithubConnectorFile[]>;
}

export interface GithubConnectorPermissionClient {
  listRepositories(owner: string, opts?: { limit?: number }): Promise<string[]>;
  listCollaborators(repo: string): Promise<GithubConnectorCollaborator[]>;
}

export interface GithubConnectorValidationClient {
  listRepositories(owner: string, opts?: { limit?: number }): Promise<string[]>;
  getRepository(repo: string): Promise<string | undefined>;
}

export interface GithubConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface GithubConnectorPermissionSyncResult {
  permissions: ConnectorPermission[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface GithubConnectorValidationResult {
  ok: boolean;
  checked: string[];
  errors: string[];
}

export interface GithubConnectorRunOptions {
  now?: string;
  maxRepositories?: number;
}

export async function validateGithubConnectorAccess(
  connector: ConnectorRecord,
  client: GithubConnectorValidationClient,
  options?: { maxRepositories?: number },
): Promise<GithubConnectorValidationResult> {
  if (connector.source !== 'github') return { ok: false, checked: [], errors: [`Validation is not implemented for ${connector.source}.`] };
  const owner = configString(connector, 'owner');
  if (!owner) return { ok: false, checked: [], errors: ['GitHub connector owner is required.'] };

  const checked: string[] = [];
  const errors: string[] = [];
  const maxRepositories = Math.max(1, options?.maxRepositories ?? 50);
  const targets = configStringList(connector, 'repositories').map((repo) => repo.includes('/') ? repo : `${owner}/${repo}`);
  if (targets.length === 0) {
    try {
      const repos = await client.listRepositories(owner, { limit: 1 });
      const first = repos[0]?.trim();
      if (first) checked.push(first);
      else errors.push(`No accessible repositories found for ${owner}.`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  } else {
    for (const target of targets.slice(0, maxRepositories)) {
      try {
        const repo = await client.getRepository(target);
        if (repo?.trim()) checked.push(repo.trim());
        else errors.push(`${target}: repository not found or inaccessible.`);
      } catch (err) {
        errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (targets.length > maxRepositories) errors.push(`Skipped ${targets.length - maxRepositories} repositories after the first ${maxRepositories}.`);
  }

  return { ok: errors.length === 0 && checked.length > 0, checked, errors };
}

export async function runGithubConnectorPermissionSync(
  connector: ConnectorRecord,
  client: GithubConnectorPermissionClient,
  options?: GithubConnectorRunOptions,
): Promise<GithubConnectorPermissionSyncResult> {
  if (connector.source !== 'github') throw new Error(`Connector source ${connector.source} is not github.`);
  const owner = configString(connector, 'owner');
  if (!owner) throw new Error('GitHub connector owner is required.');

  const now = options?.now ?? new Date().toISOString();
  const repositories = await resolveRepositories(connector, client, owner, options?.maxRepositories ?? 100);
  const permissions: ConnectorPermission[] = [];
  const failures: string[] = [];
  for (const repo of repositories) {
    try {
      const collaborators = await client.listCollaborators(repo);
      permissions.push(...collaborators.map((collaborator) => collaboratorPermission(connector, repo, collaborator)));
    } catch (err) {
      failures.push(`${repo} permissions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    permissions,
    failures,
    checkpoint: {
      permissionSyncedAt: now,
      repositories,
      permissionCount: permissions.length,
      failureCount: failures.length,
    },
  };
}

export async function runGithubConnectorCheckpoint(
  connector: ConnectorRecord,
  client: GithubConnectorClient,
  options?: GithubConnectorRunOptions,
): Promise<GithubConnectorRunResult> {
  if (connector.source !== 'github') throw new Error(`Connector source ${connector.source} is not github.`);
  const owner = configString(connector, 'owner');
  if (!owner) throw new Error('GitHub connector owner is required.');
  const includeIssues = connector.config.includeIssues !== false;
  const includePullRequests = connector.config.includePullRequests !== false;
  const includeFiles = connector.config.includeFiles === true;
  if (!includeIssues && !includePullRequests && !includeFiles) {
    throw new Error('GitHub connector must include at least one content type.');
  }

  const since = typeof connector.checkpoint?.highWatermark === 'string' ? connector.checkpoint.highWatermark : undefined;
  const now = options?.now ?? new Date().toISOString();
  const failures: string[] = [];
  const documents: ConnectorDocument[] = [];
  const repositories = await resolveRepositories(connector, client, owner, options?.maxRepositories ?? 100);

  for (const repo of repositories) {
    if (includeIssues) {
      try {
        const issues = await client.listIssues(repo, { since });
        documents.push(...issues.map((issue) => issueDocument(connector, repo, issue)));
      } catch (err) {
        failures.push(`${repo} issues: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (includePullRequests) {
      try {
        const pulls = await client.listPullRequests(repo, { since });
        documents.push(...pulls.map((pull) => pullRequestDocument(connector, repo, pull)));
      } catch (err) {
        failures.push(`${repo} pull requests: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (includeFiles) {
      try {
        const files = await client.listFiles(repo, { since });
        documents.push(...files.map((file) => fileDocument(connector, repo, file)));
      } catch (err) {
        failures.push(`${repo} files: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const highWatermark = maxIso([since, ...documents.map((doc) => doc.updatedAt), now]);
  return {
    documents,
    failures,
    checkpoint: {
      highWatermark,
      repositories,
      completedAt: now,
      documentCount: documents.length,
      failureCount: failures.length,
    },
  };
}

async function resolveRepositories(
  connector: ConnectorRecord,
  client: Pick<GithubConnectorClient, 'listRepositories'>,
  owner: string,
  maxRepositories: number,
): Promise<string[]> {
  const configured = configStringList(connector, 'repositories');
  const repos = configured.length
    ? configured.map((repo) => repo.includes('/') ? repo : `${owner}/${repo}`)
    : await client.listRepositories(owner, { limit: maxRepositories });
  const unique: string[] = [];
  for (const repo of repos) {
    const trimmed = repo.trim();
    if (trimmed && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique.slice(0, maxRepositories);
}

function issueDocument(connector: ConnectorRecord, repo: string, issue: GithubConnectorIssue): ConnectorDocument {
  const labels = (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name ?? '').filter(Boolean);
  const assignees = (issue.assignees ?? []).map((assignee) => assignee.login ?? '').filter(Boolean);
  const title = `#${issue.number} ${issue.title}`;
  return {
    id: `github:${repo}:issue:${issue.number}`,
    connectorId: connector.id,
    source: 'github',
    kind: 'issue',
    repository: repo,
    title,
    url: issue.url,
    updatedAt: issue.updatedAt,
    text: [`Issue ${title}`, issue.state ? `State: ${issue.state}` : undefined, labels.length ? `Labels: ${labels.join(', ')}` : undefined, assignees.length ? `Assignees: ${assignees.join(', ')}` : undefined, issue.body ?? undefined].filter(Boolean).join('\n\n'),
    metadata: { number: issue.number, state: issue.state, labels, assignees },
  };
}

function pullRequestDocument(connector: ConnectorRecord, repo: string, pull: GithubConnectorPullRequest): ConnectorDocument {
  const title = `#${pull.number} ${pull.title}`;
  return {
    id: `github:${repo}:pull:${pull.number}`,
    connectorId: connector.id,
    source: 'github',
    kind: 'pull-request',
    repository: repo,
    title,
    url: pull.url,
    updatedAt: pull.updatedAt,
    text: [`Pull request ${title}`, pull.state ? `State: ${pull.state}` : undefined, pull.author?.login ? `Author: ${pull.author.login}` : undefined, pull.body ?? undefined].filter(Boolean).join('\n\n'),
    metadata: { number: pull.number, state: pull.state, author: pull.author?.login },
  };
}

function fileDocument(connector: ConnectorRecord, repo: string, file: GithubConnectorFile): ConnectorDocument {
  return {
    id: `github:${repo}:file:${file.path}`,
    connectorId: connector.id,
    source: 'github',
    kind: 'file',
    repository: repo,
    title: file.path,
    url: file.url,
    updatedAt: file.updatedAt,
    text: file.text ?? '',
    metadata: { path: file.path, size: file.size, sha: file.sha },
  };
}

function collaboratorPermission(connector: ConnectorRecord, repo: string, collaborator: GithubConnectorCollaborator): ConnectorPermission {
  const login = collaborator.login.trim();
  const role = collaborator.roleName?.trim() || roleFromPermissions(collaborator.permissions);
  return {
    id: `github:${repo}:user:${login}`,
    connectorId: connector.id,
    source: 'github',
    principalId: login,
    principalKind: 'user',
    role,
    repositories: [repo],
    displayName: collaborator.name ?? undefined,
    url: collaborator.htmlUrl,
    metadata: {
      roleName: collaborator.roleName,
      permissions: collaborator.permissions ?? {},
    },
  };
}

function roleFromPermissions(permissions?: GithubConnectorCollaborator['permissions']): string {
  if (permissions?.admin) return 'admin';
  if (permissions?.maintain) return 'maintain';
  if (permissions?.push) return 'write';
  if (permissions?.triage) return 'triage';
  if (permissions?.pull) return 'read';
  return 'unknown';
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
