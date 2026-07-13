import type { ResolvedConnector } from './store.js';

export interface ConnectorResource { id: string; label: string; selected: boolean; kind: string }

export const CONNECTOR_RESOURCE_FIELDS: Record<string, string | undefined> = {
  github: 'repositories',
  gitlab: 'projects',
  slack: 'channels',
  'google-drive': 'folderIds',
  gmail: undefined,
  notion: 'databaseIds',
  linear: 'teamKeys',
};

function selectedValues(connector: ResolvedConnector): Set<string> {
  const field = CONNECTOR_RESOURCE_FIELDS[connector.source];
  const value = field ? connector.config[field] : undefined;
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

async function json(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Resource discovery failed (HTTP ${response.status})`);
  return response.json();
}

/** Enumerate selectable resources without returning the sealed token. Results
 * are intentionally capped to keep the management request bounded. */
export async function discoverConnectorResources(connector: ResolvedConnector): Promise<ConnectorResource[]> {
  const token = connector.credential?.accessToken?.trim();
  if (!token) return [];
  const selected = selectedValues(connector);
  let rows: Array<{ id: string; label: string; kind: string }> = [];
  switch (connector.source) {
    case 'github': {
      const data = await json('https://api.github.com/user/repos?per_page=100&sort=updated', token, { headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
      rows = (Array.isArray(data) ? data : []).map((item: any) => ({ id: String(item.full_name ?? ''), label: String(item.full_name ?? ''), kind: 'repository' }));
      break;
    }
    case 'gitlab': {
      const configured = typeof connector.config.hostUrl === 'string' ? connector.config.hostUrl : 'https://gitlab.com';
      const base = configured.replace(/\/+$/, '');
      const response = await fetch(`${base}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Resource discovery failed (HTTP ${response.status})`);
      const data = await response.json() as any[];
      rows = (Array.isArray(data) ? data : []).map((item: any) => ({ id: String(item.path_with_namespace ?? ''), label: String(item.path_with_namespace ?? ''), kind: 'project' }));
      break;
    }
    case 'slack': {
      const data = await json('https://slack.com/api/conversations.list?types=public_channel%2Cprivate_channel&exclude_archived=true&limit=200', token);
      if (data?.ok === false) throw new Error(`Slack resource discovery failed: ${String(data.error ?? 'unknown error')}`);
      rows = (Array.isArray(data?.channels) ? data.channels : []).map((item: any) => ({ id: String(item.id ?? ''), label: item.name ? `#${String(item.name)}` : String(item.id ?? ''), kind: 'channel' }));
      break;
    }
    case 'google-drive': {
      const q = encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false");
      const data = await json(`https://www.googleapis.com/drive/v3/files?pageSize=100&q=${q}&fields=files(id%2Cname)`, token);
      rows = (Array.isArray(data?.files) ? data.files : []).map((item: any) => ({ id: String(item.id ?? ''), label: String(item.name ?? item.id ?? ''), kind: 'folder' }));
      break;
    }
    case 'gmail': {
      const data = await json('https://gmail.googleapis.com/gmail/v1/users/me/labels', token);
      rows = (Array.isArray(data?.labels) ? data.labels : []).map((item: any) => ({ id: String(item.id ?? ''), label: String(item.name ?? item.id ?? ''), kind: 'label' }));
      break;
    }
    case 'notion': {
      const data = await json('https://api.notion.com/v1/search', token, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' }, body: JSON.stringify({ page_size: 100, filter: { property: 'object', value: 'database' } }) });
      rows = (Array.isArray(data?.results) ? data.results : []).map((item: any) => ({ id: String(item.id ?? ''), label: notionTitle(item) || String(item.id ?? ''), kind: 'database' }));
      break;
    }
    case 'linear': {
      const data = await json('https://api.linear.app/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query BrainRouterConnectorResources { teams(first: 100) { nodes { id key name } } }' }) });
      rows = (Array.isArray(data?.data?.teams?.nodes) ? data.data.teams.nodes : []).map((item: any) => ({ id: String(item.key ?? ''), label: String(item.name ?? item.key ?? ''), kind: 'team' }));
      break;
    }
  }
  const unique = new Map<string, ConnectorResource>();
  for (const row of rows) if (row.id) unique.set(row.id, { ...row, selected: selected.has(row.id) });
  for (const id of selected) if (!unique.has(id)) unique.set(id, { id, label: id, kind: CONNECTOR_RESOURCE_FIELDS[connector.source] ?? 'resource', selected: true });
  return [...unique.values()].slice(0, 200);
}

function notionTitle(item: any): string {
  const title = Array.isArray(item?.title) ? item.title : [];
  return title.map((part: any) => String(part?.plain_text ?? '')).join('').trim();
}

const accountCache = new Map<string, { until: number; value: string | null }>();

/** Resolve a human-readable connected identity for the status surface. The
 * result is cached briefly so opening Integrations does not fan out on every
 * React refresh. */
export async function discoverConnectorAccount(connector: ResolvedConnector): Promise<string | null> {
  const cached = accountCache.get(connector.id);
  if (cached && cached.until > Date.now()) return cached.value;
  const token = connector.credential?.accessToken?.trim();
  if (!token) return null;
  let value: string | null = null;
  switch (connector.source) {
    case 'github': { const data = await json('https://api.github.com/user', token, { headers: { 'X-GitHub-Api-Version': '2022-11-28' } }); value = String(data?.login ?? data?.name ?? '') || null; break; }
    case 'gitlab': { const base = (typeof connector.config.hostUrl === 'string' ? connector.config.hostUrl : 'https://gitlab.com').replace(/\/+$/, ''); const data = await json(`${base}/api/v4/user`, token); value = String(data?.username ?? data?.name ?? '') || null; break; }
    case 'slack': { const data = await json('https://slack.com/api/auth.test', token); value = data?.ok === false ? null : [data?.team, data?.user].filter(Boolean).join(' · ') || null; break; }
    case 'google-drive': { const data = await json('https://www.googleapis.com/oauth2/v2/userinfo', token); value = String(data?.email ?? data?.name ?? '') || null; break; }
    case 'gmail': { const data = await json('https://gmail.googleapis.com/gmail/v1/users/me/profile', token); value = String(data?.emailAddress ?? '') || null; break; }
    case 'notion': { const data = await json('https://api.notion.com/v1/users/me', token, { headers: { 'Notion-Version': '2022-06-28' } }); value = String(data?.name ?? data?.bot?.owner?.user?.name ?? data?.id ?? '') || null; break; }
    case 'linear': { const data = await json('https://api.linear.app/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query BrainRouterConnectorIdentity { viewer { id name email } }' }) }); value = String(data?.data?.viewer?.email ?? data?.data?.viewer?.name ?? '') || null; break; }
  }
  accountCache.set(connector.id, { until: Date.now() + 60_000, value });
  return value;
}
