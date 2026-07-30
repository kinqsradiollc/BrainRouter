import type { FetchLike, GithubCollaborator, GithubComment, GithubIssue } from '../githubSync/types.js';

export interface GitlabTrackCompatOptions {
  apiBase?: string;
  token: string;
  fetchImpl: FetchLike;
  authMode?: 'private-token' | 'bearer';
}

type GitlabUser = { username?: string; name?: string };
type GitlabIssue = {
  iid: number; title: string; description?: string | null; state?: string; labels?: string[];
  web_url?: string; updated_at?: string; author?: GitlabUser; assignees?: GitlabUser[];
};
type GitlabNote = { id: number; body?: string; author?: GitlabUser; created_at?: string };
type GitlabMember = { username?: string; name?: string; access_level?: number };

function response(status: number, data: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => typeof data === 'string' ? data : JSON.stringify(data ?? ''),
  };
}

function issue(row: GitlabIssue): GithubIssue {
  return {
    number: row.iid,
    title: row.title,
    body: row.description ?? '',
    state: row.state === 'closed' ? 'closed' : 'open',
    labels: row.labels ?? [],
    html_url: row.web_url,
    assignee: row.assignees?.[0]?.username ? { login: row.assignees[0].username! } : null,
    assignees: (row.assignees ?? []).flatMap((user) => user.username ? [{ login: user.username, ...(user.name ? { name: user.name } : {}) }] : []),
    updated_at: row.updated_at,
  };
}

function comment(row: GitlabNote): GithubComment {
  return {
    id: row.id,
    body: row.body ?? '',
    user: row.author?.username ? { login: row.author.username, ...(row.author.name ? { name: row.author.name } : {}) } : null,
    ...(row.created_at ? { created_at: row.created_at } : {}),
  };
}

function collaborator(row: GitlabMember): GithubCollaborator | undefined {
  if (!row.username) return undefined;
  const access = Number(row.access_level ?? 0);
  const role = access >= 50 ? 'admin' : access >= 40 ? 'maintain' : access >= 30 ? 'write' : access >= 20 ? 'read' : 'triage';
  return { login: row.username, ...(row.name ? { name: row.name } : {}), role_name: role };
}

function parseCompatPath(url: string): { repo: string; resource: string; query: URLSearchParams } | undefined {
  const parsed = new URL(url);
  const marker = '/repos/';
  const start = parsed.pathname.indexOf(marker);
  if (start < 0) return undefined;
  const rest = parsed.pathname.slice(start + marker.length);
  const resourceStart = rest.search(/\/(?:issues(?:\/\d+(?:\/comments)?)?|collaborators)$/);
  if (resourceStart <= 0) return undefined;
  return { repo: decodeURIComponent(rest.slice(0, resourceStart)), resource: rest.slice(resourceStart), query: parsed.searchParams };
}

function gitlabIssuePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof raw.title === 'string') payload.title = raw.title;
  if (typeof raw.body === 'string') payload.description = raw.body;
  if (Array.isArray(raw.labels)) payload.labels = raw.labels.map(String).join(',');
  if (raw.state === 'closed') payload.state_event = 'close';
  if (raw.state === 'open') payload.state_event = 'reopen';
  return payload;
}

/**
 * Adapt GitLab Issues REST to the narrow GitHub-shaped FetchLike contract used
 * by Track's mature three-way merge engine. This keeps conflict/baseline and
 * comment idempotency identical across both forges while translating only the
 * provider wire format at the edge.
 */
export function createGitlabTrackCompatFetch(options: GitlabTrackCompatOptions): FetchLike {
  const apiBase = (options.apiBase?.trim() || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
  const authHeaders: Record<string, string> = options.authMode === 'bearer'
    ? { Authorization: `Bearer ${options.token}` }
    : { 'PRIVATE-TOKEN': options.token };
  return async (url, init) => {
    const target = parseCompatPath(url);
    if (!target) return response(400, { message: 'unsupported Track compatibility path' });
    const method = (init?.method ?? 'GET').toUpperCase();
    let rawBody: Record<string, unknown> = {};
    try { rawBody = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {}; } catch { return response(400, { message: 'invalid request body' }); }
    const project = encodeURIComponent(target.repo);
    const issueMatch = target.resource.match(/^\/issues\/(\d+)(\/comments)?$/);
    let endpoint = `${apiBase}/projects/${project}`;
    let body: Record<string, unknown> | undefined;
    let transform: (value: unknown) => unknown = (value) => value;

    if (target.resource === '/issues') {
      endpoint += '/issues';
      if (method === 'GET') {
        const query = new URLSearchParams({ scope: 'all', state: target.query.get('state') === 'open' ? 'opened' : target.query.get('state') === 'closed' ? 'closed' : 'all', per_page: target.query.get('per_page') ?? '100' });
        endpoint += `?${query}`;
        transform = (value) => (Array.isArray(value) ? value : []).map((row) => issue(row as GitlabIssue));
      } else body = gitlabIssuePayload(rawBody);
      if (method === 'POST') transform = (value) => issue(value as GitlabIssue);
    } else if (issueMatch) {
      const iid = Number(issueMatch[1]);
      if (issueMatch[2]) {
        endpoint += `/issues/${iid}/notes`;
        if (method === 'POST') body = { body: String(rawBody.body ?? '') };
        transform = (value) => Array.isArray(value) ? value.map((row) => comment(row as GitlabNote)) : comment(value as GitlabNote);
      } else {
        endpoint += `/issues/${iid}`;
        if (method === 'PATCH' || method === 'PUT') body = gitlabIssuePayload(rawBody);
        transform = (value) => issue(value as GitlabIssue);
      }
    } else if (target.resource === '/collaborators' && method === 'GET') {
      endpoint += '/members/all?per_page=100';
      transform = (value) => (Array.isArray(value) ? value : []).flatMap((row) => {
        const mapped = collaborator(row as GitlabMember);
        return mapped ? [mapped] : [];
      });
    } else return response(405, { message: 'unsupported Track compatibility operation' });

    const upstream = await options.fetchImpl(endpoint, {
      method: method === 'PATCH' ? 'PUT' : method,
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data: unknown;
    try { data = await upstream.json(); } catch { data = await upstream.text(); }
    return response(upstream.status, upstream.ok ? transform(data) : data);
  };
}
