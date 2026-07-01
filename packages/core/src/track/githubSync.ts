/**
 * TRACK — external sync (GitHub Issues).
 *
 * A pure, dependency-injected bridge between the per-workspace Track project and
 * a GitHub repository's issues. The mapping functions are pure and unit-tested;
 * the import/export engine takes a pluggable `fetch` so it runs offline in tests
 * and against the real API in the CLI/desktop. No secrets live here — the caller
 * resolves the token + repo (from `config.json` `cli.track.github`, with a
 * `GITHUB_TOKEN` env fallback) and passes them in.
 *
 * Round-trip identity: each exported issue carries an HTML-comment marker with
 * its work-item key, and the store keeps a `githubLinks` side-map (work-item id →
 * issue number/url) so re-runs UPDATE rather than duplicate.
 */
import type { TrackProject, WorkItem, WorkItemType, WorkItemPriority, StatusCategory, ProjectMember, ProjectRole } from '@kinqs/brainrouter-types';
import { isWorkItemType, isWorkItemPriority, isTerminalCategory } from '@kinqs/brainrouter-types';
import {
  ensureProject,
  listWorkItems,
  getWorkItem,
  createWorkItem,
  updateWorkItem,
  getGithubLinks,
  setGithubLink,
  listMembers,
  addMember,
  addComment,
  recordCommentSync,
  upsertLabel,
  LOCAL_MEMBER_ID,
  type CreateWorkItemInput,
  type UpdateWorkItemPatch,
  type GithubMirrorSnapshot,
} from './trackStore.js';
import { getRawCliKnobs } from '../config/config.js';
import { listConnectors } from '../connectors/connectorStore.js';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';

// ── GitHub shapes (the minimal subset we read/write) ──────────────────────────

export interface GithubUser { login: string; name?: string | null }

export interface GithubIssue {
  number: number;
  title: string;
  body?: string | null;
  state?: 'open' | 'closed';
  /** GitHub returns hex `color` (no `#`) on the object form. */
  labels?: Array<string | { name?: string; color?: string }>;
  html_url?: string;
  /** The assigned user(s). `assignee` is the legacy single field. */
  assignee?: GithubUser | null;
  assignees?: GithubUser[];
  /** ISO-8601 last-modified time; recorded as a cheap "did GitHub change?" hint. */
  updated_at?: string;
  /** Present on PRs — used to filter them out of the issues list. */
  pull_request?: unknown;
}

/** A GitHub issue comment (the subset we sync). */
export interface GithubComment {
  id: number;
  body?: string | null;
  user?: GithubUser | null;
  html_url?: string;
  created_at?: string;
}

export interface GithubIssuePayload {
  title: string;
  body: string;
  labels: string[];
  /** GitHub logins to assign (mapped from the work item's assignee). */
  assignees: string[];
  state?: 'open' | 'closed';
}

/** A repo collaborator, as returned by `GET /repos/{repo}/collaborators`. */
export interface GithubCollaborator {
  login: string;
  name?: string | null;
  /** Coarse `role_name` (admin · maintain · write · triage · read), newer API. */
  role_name?: string;
  /** Per-capability booleans, older API. */
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

/** A minimal structural subset of the global `fetch` so it can be mocked in tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

// ── Pure mapping ──────────────────────────────────────────────────────────────

const MARKER_RE = /<!--\s*brainrouter:([A-Za-z0-9]+-\d+)\s*-->/;

/** The hidden marker appended to an exported issue body so imports round-trip. */
export function keyMarker(key: string): string {
  return `<!-- brainrouter:${key} -->`;
}

/** Extract a work-item key from an issue body marker, if present. */
export function keyFromBody(body: string | null | undefined): string | undefined {
  const m = (body ?? '').match(MARKER_RE);
  return m ? m[1] : undefined;
}

const labelNames = (labels: GithubIssue['labels']): string[] =>
  (labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean);

/** Extract {name, color} pairs from issue labels (GitHub hex `color` has no `#`). */
const labelColors = (labels: GithubIssue['labels']): Array<{ name: string; color?: string }> =>
  (labels ?? [])
    .map((l) => (typeof l === 'string' ? { name: l } : { name: l?.name ?? '', color: l?.color ? `#${l.color}` : undefined }))
    .filter((l) => l.name && !l.name.startsWith('type:') && !l.name.startsWith('priority:'));

/** A work item → the issue payload we POST/PATCH. Status category drives open/closed. */
export function workItemToIssue(item: WorkItem, includeMarker = true): GithubIssuePayload {
  const labels = [
    `type:${item.type}`,
    `priority:${item.priority}`,
    ...item.labels.filter((l) => !l.startsWith('type:') && !l.startsWith('priority:')),
  ];
  const desc = item.description ? `${item.description}\n\n` : '';
  const body = includeMarker ? `${desc}${keyMarker(item.key)}` : desc.trimEnd();
  // Assignees are treated as GitHub logins (members are pulled from the repo).
  return { title: item.title, body, labels, assignees: item.assignees, state: isTerminalCategory(item.statusCategory) ? 'closed' : 'open' };
}

/** Every GitHub login assigned to an issue (legacy `assignee` + the `assignees` array, deduped). */
function issueAssignees(issue: GithubIssue): string[] {
  const out: string[] = [];
  for (const login of [issue.assignee?.login, ...(issue.assignees ?? []).map((a) => a?.login)]) {
    if (login && !out.includes(login)) out.push(login);
  }
  return out;
}

/** Resolve a concrete project status id for a target category (first match). */
function statusForCategory(project: TrackProject, category: StatusCategory): string {
  return project.workflowStates.find((s) => s.category === category)?.id ?? project.workflowStates[0]?.id ?? 'backlog';
}

export interface MappedIssue {
  /** Work-item key parsed from the body marker, if this issue came from us. */
  key?: string;
  input: CreateWorkItemInput;
  /** The subset to apply when updating an existing item. */
  patch: UpdateWorkItemPatch & { labels?: string[] };
}

/** A GitHub issue → the fields we create/update a work item with. */
export function issueToWorkItem(issue: GithubIssue, project: TrackProject): MappedIssue {
  const names = labelNames(issue.labels);
  const typeLabel = names.find((n) => n.startsWith('type:'))?.slice('type:'.length);
  const priLabel = names.find((n) => n.startsWith('priority:'))?.slice('priority:'.length);
  const type: WorkItemType = isWorkItemType(typeLabel) ? typeLabel : 'task';
  const priority: WorkItemPriority = isWorkItemPriority(priLabel) ? priLabel : 'none';
  const plainLabels = names.filter((n) => !n.startsWith('type:') && !n.startsWith('priority:'));
  const status = statusForCategory(project, issue.state === 'closed' ? 'completed' : 'unstarted');
  const body = (issue.body ?? '').replace(MARKER_RE, '').trim();
  const assignees = issueAssignees(issue);
  return {
    key: keyFromBody(issue.body),
    input: { title: issue.title, type, priority, status, description: body || undefined, labels: plainLabels, assignees },
    patch: { title: issue.title, priority, status, description: body || undefined, labels: plainLabels, assignees },
  };
}

// ── Sync engine ───────────────────────────────────────────────────────────────

export interface SyncOptions {
  repo: string; // "owner/name"
  token: string;
  fetchImpl: FetchLike;
  /** When true, compute the plan but perform NO writes (local or remote). */
  dryRun?: boolean;
  /** Base API url (override for GitHub Enterprise / tests). */
  apiBase?: string;
}

export interface ExportPlanEntry { key: string; title: string; action: 'create' | 'update'; issueNumber?: number }
export interface ImportPlanEntry { issueNumber: number; title: string; action: 'create' | 'update'; key?: string }
export interface SyncResult {
  direction: 'export' | 'import' | 'sync';
  dryRun: boolean;
  exported?: ExportPlanEntry[];
  imported?: ImportPlanEntry[];
  /** Comment-sync tallies (G1): pushed = local→GitHub, pulled = GitHub→local. */
  comments?: { pushed: number; pulled: number };
  /** Bidirectional-sync tallies: fields pushed up / pulled down, items created each side. */
  pushed?: number;
  pulled?: number;
  created?: { local: number; remote: number };
  /** Fields that changed on BOTH sides since the last sync — surfaced, never clobbered. */
  conflicts?: Array<{ key: string; field: string }>;
  errors: string[];
}

export interface GithubRepoConfig {
  repo: string;
  token?: string;
  label?: string;
}
export type GithubTokenSource = 'config' | 'env' | 'connector-env';
export interface ResolvedGithubConfig { repo?: string; token?: string; tokenSource?: GithubTokenSource; connectorId?: string }
export interface ResolvedGithubRepoSummary {
  repo: string;
  hasToken: boolean;
  tokenSource?: GithubTokenSource;
  active: boolean;
  label?: string;
  connectorId?: string;
  source?: 'track' | 'connector';
}

function envGithubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

function normalizeGithubRepos(knobs: NonNullable<ReturnType<typeof getRawCliKnobs>['track']>): GithubRepoConfig[] {
  const byRepo = new Map<string, GithubRepoConfig>();
  const add = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Record<string, unknown>;
    const repo = typeof e.repo === 'string' ? e.repo.trim() : '';
    if (!repo) return;
    const token = typeof e.token === 'string' && e.token.trim() ? e.token.trim() : undefined;
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined;
    byRepo.set(repo, { ...byRepo.get(repo), repo, token: token ?? byRepo.get(repo)?.token, label: label ?? byRepo.get(repo)?.label });
  };
  if (Array.isArray(knobs.githubRepos)) for (const entry of knobs.githubRepos) add(entry);
  const legacyRepo = knobs.githubRepo?.trim();
  if (legacyRepo) {
    const existing = byRepo.get(legacyRepo);
    const legacyToken = knobs.githubToken?.trim() || undefined;
    byRepo.set(legacyRepo, { ...existing, repo: legacyRepo, token: existing?.token ?? legacyToken });
  }
  return [...byRepo.values()];
}

export function listResolvedGithubConfigs(): ResolvedGithubRepoSummary[] {
  const knobs = getRawCliKnobs().track ?? {};
  const repos = normalizeGithubRepos(knobs);
  const active = knobs.activeGithubRepo?.trim() || knobs.githubRepo?.trim() || repos[0]?.repo;
  const envToken = envGithubToken();
  const legacyToken = knobs.githubToken?.trim() || undefined;
  return repos.map((entry) => {
    const cfgToken = entry.token?.trim() || legacyToken;
    const token = cfgToken || envToken;
    return {
      repo: entry.repo,
      hasToken: !!token,
      tokenSource: token ? (cfgToken ? 'config' : 'env') : undefined,
      active: entry.repo === active,
      label: entry.label,
    };
  });
}

/**
 * Resolve the GitHub repo + token for sync, layering explicit args over
 * `config.json` `cli.track.*`, with the standard `GITHUB_TOKEN`/`GH_TOKEN` env
 * as the final token fallback (the gh-CLI convention — not a BrainRouter env).
 */
export function resolveGithubConfig(repoArg?: string, tokenArg?: string): ResolvedGithubConfig {
  const knobs = getRawCliKnobs().track ?? {};
  const repos = normalizeGithubRepos(knobs);
  const repo = repoArg?.trim() || knobs.activeGithubRepo?.trim() || knobs.githubRepo?.trim() || repos[0]?.repo;
  const matched = repo ? repos.find((r) => r.repo === repo) : undefined;
  const cfgToken = tokenArg?.trim() || matched?.token?.trim() || knobs.githubToken?.trim() || undefined;
  const envToken = envGithubToken();
  const token = cfgToken || envToken;
  return { repo, token, tokenSource: token ? (cfgToken ? 'config' : 'env') : undefined };
}

interface ConnectorGithubRepoConfig extends GithubRepoConfig {
  connectorId: string;
  tokenSource?: 'connector-env';
}

function connectorToken(connector: ConnectorRecord): string | undefined {
  if (connector.credential?.mode !== 'static') return undefined;
  const ref = connector.credential.ref?.trim();
  return ref ? process.env[ref]?.trim() || undefined : undefined;
}

function connectorGithubRepos(workspaceRoot: string): ConnectorGithubRepoConfig[] {
  const byRepo = new Map<string, ConnectorGithubRepoConfig>();
  for (const connector of listConnectors(workspaceRoot, { source: 'github' })) {
    if (connector.status === 'deleting' || connector.status === 'paused') continue;
    const owner = typeof connector.config.owner === 'string' ? connector.config.owner.trim().replace(/^\/+|\/+$/g, '') : '';
    const rawRepos = Array.isArray(connector.config.repositories)
      ? connector.config.repositories.filter((repo): repo is string => typeof repo === 'string' && repo.trim().length > 0)
      : [];
    if (rawRepos.length === 0) continue;
    const token = connectorToken(connector);
    for (const rawRepo of rawRepos) {
      const repoName = rawRepo.trim().replace(/^\/+|\/+$/g, '');
      const repo = repoName.includes('/') ? repoName : (owner ? `${owner}/${repoName}` : '');
      if (!repo) continue;
      const existing = byRepo.get(repo);
      if (existing?.token) continue;
      byRepo.set(repo, {
        repo,
        label: connector.name,
        connectorId: connector.id,
        token: token ?? existing?.token,
        tokenSource: token ? 'connector-env' : existing?.tokenSource,
      });
    }
  }
  return [...byRepo.values()];
}

export function listResolvedGithubConfigsForWorkspace(workspaceRoot: string): ResolvedGithubRepoSummary[] {
  const trackRows = listResolvedGithubConfigs().map((row): ResolvedGithubRepoSummary => ({ ...row, source: 'track' }));
  const byRepo = new Map<string, ResolvedGithubRepoSummary>();
  for (const row of trackRows) byRepo.set(row.repo, row);

  for (const entry of connectorGithubRepos(workspaceRoot)) {
    const existing = byRepo.get(entry.repo);
    const connectorRow: ResolvedGithubRepoSummary = {
      repo: entry.repo,
      hasToken: !!entry.token,
      tokenSource: entry.token ? entry.tokenSource : undefined,
      active: false,
      label: entry.label,
      connectorId: entry.connectorId,
      source: 'connector',
    };
    if (!existing) {
      byRepo.set(entry.repo, connectorRow);
      continue;
    }
    byRepo.set(entry.repo, {
      ...existing,
      hasToken: existing.hasToken || !!entry.token,
      tokenSource: existing.hasToken ? existing.tokenSource : (entry.token ? entry.tokenSource : existing.tokenSource),
      label: existing.label ?? entry.label,
      connectorId: existing.connectorId ?? entry.connectorId,
    });
  }

  const rows = [...byRepo.values()];
  if (!rows.some((row) => row.active) && rows.length > 0) rows[0] = { ...rows[0], active: true };
  return rows;
}

export function resolveGithubConfigForWorkspace(workspaceRoot: string, repoArg?: string, tokenArg?: string): ResolvedGithubConfig {
  const base = resolveGithubConfig(repoArg, tokenArg);
  if (base.repo && base.token) return base;

  const connectorRepos = connectorGithubRepos(workspaceRoot);
  const connector = base.repo
    ? connectorRepos.find((entry) => entry.repo === base.repo)
    : connectorRepos[0];
  if (!connector) return base;
  if (base.repo && !connector.token) return { ...base, connectorId: connector.connectorId };
  const useConnectorToken = !!connector.token && (!base.token || base.tokenSource === 'env');
  return {
    repo: base.repo ?? connector.repo,
    token: useConnectorToken ? connector.token : (base.token ?? connector.token),
    tokenSource: useConnectorToken ? connector.tokenSource : (base.tokenSource ?? connector.tokenSource),
    connectorId: connector.connectorId,
  };
}

function ghHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}

function apiRoot(opts: SyncOptions): string {
  return `${opts.apiBase ?? 'https://api.github.com'}/repos/${opts.repo}`;
}

function issueCommentsUrl(opts: SyncOptions, issueNumber: number): string {
  return `${apiRoot(opts)}/issues/${issueNumber}/comments`;
}

/**
 * Push the work item's locally-authored comments (those without an `externalId`)
 * to the GitHub issue, recording each returned comment id so it never re-pushes
 * or re-imports. Returns the count pushed.
 */
async function pushComments(workspaceRoot: string, opts: SyncOptions, item: WorkItem, issueNumber: number, errors: string[]): Promise<number> {
  let pushed = 0;
  for (const c of item.comments) {
    if (c.externalId) continue; // already mirrored to GitHub
    try {
      const res = await opts.fetchImpl(issueCommentsUrl(opts, issueNumber), {
        method: 'POST', headers: ghHeaders(opts.token), body: JSON.stringify({ body: c.body }),
      });
      if (!res.ok) { errors.push(`${item.key} comment: push failed (HTTP ${res.status})`); continue; }
      const created = (await res.json()) as GithubComment;
      recordCommentSync(workspaceRoot, item.id, c.id, { externalSource: 'github', externalId: String(created.id) });
      pushed += 1;
    } catch (e) {
      errors.push(`${item.key} comment: ${(e as Error).message}`);
    }
  }
  return pushed;
}

/**
 * Pull the GitHub issue's comments that aren't yet mirrored locally (matched by
 * the GitHub comment id) and append them to the work item. Returns the count pulled.
 */
async function pullComments(workspaceRoot: string, opts: SyncOptions, itemId: string, issueNumber: number, errors: string[]): Promise<number> {
  let remote: GithubComment[] = [];
  try {
    const res = await opts.fetchImpl(`${issueCommentsUrl(opts, issueNumber)}?per_page=100`, { headers: ghHeaders(opts.token) });
    if (!res.ok) { errors.push(`#${issueNumber} comments: list failed (HTTP ${res.status})`); return 0; }
    remote = (await res.json()) as GithubComment[];
  } catch (e) {
    errors.push(`#${issueNumber} comments: ${(e as Error).message}`);
    return 0;
  }
  const item = getWorkItem(workspaceRoot, itemId);
  const known = new Set((item?.comments ?? []).map((c) => c.externalId).filter(Boolean) as string[]);
  let pulled = 0;
  for (const gc of remote) {
    const ext = String(gc.id);
    if (known.has(ext)) continue;
    addComment(workspaceRoot, itemId, gc.user?.login ?? 'github', gc.body ?? '', { externalSource: 'github', externalId: ext });
    known.add(ext);
    pulled += 1;
  }
  return pulled;
}

/**
 * Push local work items to GitHub. New items are created (and the issue number
 * recorded); previously-synced items are updated. Returns the plan; with
 * `dryRun` no network calls or store writes happen.
 */
export async function exportToGithub(workspaceRoot: string, opts: SyncOptions): Promise<SyncResult> {
  ensureProject(workspaceRoot);
  const items = listWorkItems(workspaceRoot);
  const links = getGithubLinks(workspaceRoot);
  const plan: ExportPlanEntry[] = [];
  const errors: string[] = [];

  let pushed = 0;
  for (const item of items) {
    const existing = links[item.id];
    plan.push({ key: item.key, title: item.title, action: existing ? 'update' : 'create', issueNumber: existing?.number });
    if (opts.dryRun) { pushed += item.comments.filter((c) => !c.externalId).length; continue; }
    const payload = workItemToIssue(item);
    try {
      let issueNumber = existing?.number;
      if (existing) {
        const res = await opts.fetchImpl(`${apiRoot(opts)}/issues/${existing.number}`, {
          method: 'PATCH', headers: ghHeaders(opts.token), body: JSON.stringify(payload),
        });
        if (!res.ok) errors.push(`${item.key}: update failed (HTTP ${res.status})`);
      } else {
        const res = await opts.fetchImpl(`${apiRoot(opts)}/issues`, {
          method: 'POST', headers: ghHeaders(opts.token), body: JSON.stringify({ title: payload.title, body: payload.body, labels: payload.labels, assignees: payload.assignees }),
        });
        if (!res.ok) { errors.push(`${item.key}: create failed (HTTP ${res.status})`); continue; }
        const created = (await res.json()) as GithubIssue;
        issueNumber = created.number;
        setGithubLink(workspaceRoot, item.id, { number: created.number, url: created.html_url ?? '' });
        // POST always opens the issue; close it if the item is done.
        if (payload.state === 'closed') {
          await opts.fetchImpl(`${apiRoot(opts)}/issues/${created.number}`, {
            method: 'PATCH', headers: ghHeaders(opts.token), body: JSON.stringify({ state: 'closed' }),
          });
        }
      }
      // Mirror locally-authored comments up to the issue (id-mapped, no re-push).
      if (issueNumber !== undefined) pushed += await pushComments(workspaceRoot, opts, item, issueNumber, errors);
    } catch (e) {
      errors.push(`${item.key}: ${(e as Error).message}`);
    }
  }
  return { direction: 'export', dryRun: opts.dryRun ?? false, exported: plan, comments: { pushed, pulled: 0 }, errors };
}

/**
 * Pull GitHub issues into the Track board. Issues carrying our key marker (or a
 * recorded link) UPDATE the matching work item; the rest CREATE new items. PRs
 * are skipped. With `dryRun`, fetches the issues to build the plan but writes
 * nothing.
 */
export async function importFromGithub(workspaceRoot: string, opts: SyncOptions): Promise<SyncResult> {
  const project = ensureProject(workspaceRoot);
  const plan: ImportPlanEntry[] = [];
  const errors: string[] = [];
  let issues: GithubIssue[] = [];
  try {
    const res = await opts.fetchImpl(`${apiRoot(opts)}/issues?state=all&per_page=100`, { headers: ghHeaders(opts.token) });
    if (!res.ok) return { direction: 'import', dryRun: opts.dryRun ?? false, imported: [], errors: [`list failed (HTTP ${res.status})`] };
    issues = ((await res.json()) as GithubIssue[]).filter((i) => !i.pull_request);
  } catch (e) {
    return { direction: 'import', dryRun: opts.dryRun ?? false, imported: [], errors: [(e as Error).message] };
  }

  const links = getGithubLinks(workspaceRoot);
  const byNumber = new Map<number, string>(); // issue number → work-item id
  for (const [wid, link] of Object.entries(links)) byNumber.set(link.number, wid);

  let pulled = 0;
  for (const issue of issues) {
    const mapped = issueToWorkItem(issue, project);
    const existingByKey = mapped.key ? getWorkItem(workspaceRoot, mapped.key) : undefined;
    const existingById = byNumber.get(issue.number);
    const existing = existingByKey ?? (existingById ? getWorkItem(workspaceRoot, existingById) : undefined);
    plan.push({ issueNumber: issue.number, title: issue.title, action: existing ? 'update' : 'create', key: existing?.key ?? mapped.key });
    if (opts.dryRun) continue;
    try {
      // Register the issue's labels with their real GitHub colors.
      for (const l of labelColors(issue.labels)) {
        if (l.color) upsertLabel(workspaceRoot, { name: l.name, color: l.color, externalSource: 'github' });
      }
      let itemId: string;
      if (existing) {
        updateWorkItem(workspaceRoot, existing.id, mapped.patch, 'agent');
        setGithubLink(workspaceRoot, existing.id, { number: issue.number, url: issue.html_url ?? '' });
        itemId = existing.id;
      } else {
        const created = createWorkItem(workspaceRoot, { ...mapped.input, actor: 'agent' });
        setGithubLink(workspaceRoot, created.id, { number: issue.number, url: issue.html_url ?? '' });
        itemId = created.id;
      }
      // Mirror the issue's comments down (id-mapped, no dupes on re-import).
      pulled += await pullComments(workspaceRoot, opts, itemId, issue.number, errors);
    } catch (e) {
      errors.push(`#${issue.number}: ${(e as Error).message}`);
    }
  }
  return { direction: 'import', dryRun: opts.dryRun ?? false, imported: plan, comments: { pushed: 0, pulled }, errors };
}

// ── Bidirectional sync (3-way merge) ─────────────────────────────────────────

// `type` is create-only (updateWorkItem can't change it), so it is snapshotted
// for the record but NOT reconciled — the rest are the GitHub-mirrored fields.
const MERGE_FIELDS = ['title', 'description', 'priority', 'closed', 'labels', 'assignees'] as const;
type MergeField = typeof MERGE_FIELDS[number];

const sortedSet = (a: string[]): string[] => [...new Set(a)].sort();
const sameSet = (a: string[], b: string[]): boolean => {
  const sa = sortedSet(a), sb = sortedSet(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};
const plainLabels = (labels: string[]): string[] =>
  sortedSet(labels.filter((l) => !l.startsWith('type:') && !l.startsWith('priority:')));

function eqField(f: MergeField, a: GithubMirrorSnapshot, b: GithubMirrorSnapshot): boolean {
  return f === 'labels' || f === 'assignees' ? sameSet(a[f], b[f]) : a[f] === b[f];
}

/** The local work item as a GitHub-mirror snapshot. */
export function snapshotFromItem(item: WorkItem): GithubMirrorSnapshot {
  return {
    title: item.title,
    description: item.description ?? '',
    type: item.type,
    priority: item.priority,
    labels: plainLabels(item.labels),
    assignees: sortedSet(item.assignees),
    closed: isTerminalCategory(item.statusCategory),
  };
}

/** A GitHub issue as a mirror snapshot. */
export function snapshotFromIssue(issue: GithubIssue): GithubMirrorSnapshot {
  const names = labelNames(issue.labels);
  const typeLabel = names.find((n) => n.startsWith('type:'))?.slice('type:'.length);
  const priLabel = names.find((n) => n.startsWith('priority:'))?.slice('priority:'.length);
  return {
    title: issue.title,
    description: (issue.body ?? '').replace(MARKER_RE, '').trim(),
    type: isWorkItemType(typeLabel) ? typeLabel : 'task',
    priority: isWorkItemPriority(priLabel) ? priLabel : 'none',
    labels: plainLabels(names),
    assignees: sortedSet(issueAssignees(issue)),
    closed: issue.state === 'closed',
  };
}

interface MergeOutcome {
  /** Remote-only field changes to write to the LOCAL item. */
  pull: Partial<GithubMirrorSnapshot>;
  /** True when a field changed only locally → the GitHub issue must be updated. */
  push: boolean;
  conflicts: MergeField[];
  /** The reconciled snapshot to persist as the next baseline (conflict fields kept at base). */
  merged: GithubMirrorSnapshot;
}

/**
 * 3-way merge one linked pair. Base is the last-synced snapshot; with no base
 * (first reconcile of a pre-existing link) REMOTE is treated as base, so a local
 * value that differs from remote counts as a local edit (pushed up) — biasing
 * to never silently lose local work.
 */
function mergePair(base: GithubMirrorSnapshot | undefined, local: GithubMirrorSnapshot, remote: GithubMirrorSnapshot): MergeOutcome {
  const b = base ?? remote;
  const pull: Partial<GithubMirrorSnapshot> = {};
  const conflicts: MergeField[] = [];
  // Index-write through plain records — a union-keyed property can't be written
  // to directly (its write type narrows to `never`).
  const merged = { ...local } as unknown as Record<string, unknown>;
  const bRec = b as unknown as Record<string, unknown>;
  const remoteRec = remote as unknown as Record<string, unknown>;
  const pullRec = pull as unknown as Record<string, unknown>;
  let push = false;
  for (const f of MERGE_FIELDS) {
    const localChanged = !eqField(f, local, b);
    const remoteChanged = !eqField(f, remote, b);
    if (localChanged && remoteChanged && !eqField(f, local, remote)) {
      conflicts.push(f);
      merged[f] = bRec[f];
    } else if (remoteChanged) {
      pullRec[f] = remoteRec[f];
      merged[f] = remoteRec[f];
    } else if (localChanged) {
      push = true;
    }
  }
  return { pull, push, conflicts, merged: merged as unknown as GithubMirrorSnapshot };
}

function snapshotToPatch(p: Partial<GithubMirrorSnapshot>, project: TrackProject): UpdateWorkItemPatch & { labels?: string[] } {
  const patch: UpdateWorkItemPatch & { labels?: string[] } = {};
  if (p.title !== undefined) patch.title = p.title;
  if (p.description !== undefined) patch.description = p.description || undefined;
  if (p.priority !== undefined && isWorkItemPriority(p.priority)) patch.priority = p.priority;
  if (p.labels !== undefined) patch.labels = p.labels;
  if (p.assignees !== undefined) patch.assignees = p.assignees;
  if (p.closed !== undefined) patch.status = statusForCategory(project, p.closed ? 'completed' : 'unstarted');
  return patch;
}

function snapshotToIssuePayload(snap: GithubMirrorSnapshot, key: string): GithubIssuePayload {
  return {
    title: snap.title,
    body: `${snap.description ? `${snap.description}\n\n` : ''}${keyMarker(key)}`,
    labels: [`type:${snap.type}`, `priority:${snap.priority}`, ...snap.labels],
    assignees: snap.assignees,
    state: snap.closed ? 'closed' : 'open',
  };
}

/**
 * Two-way reconcile in one pass: push local-only edits up, pull GitHub-only
 * edits down, create missing items on either side, and SURFACE (never clobber)
 * fields that changed on both sides. The per-link baseline snapshot is what lets
 * it tell a local edit from a remote edit — the fix for "pulling from GitHub
 * wipes my local changes".
 */
export async function syncBidirectional(workspaceRoot: string, opts: SyncOptions): Promise<SyncResult> {
  const project = ensureProject(workspaceRoot);
  const errors: string[] = [];
  const conflicts: Array<{ key: string; field: string }> = [];
  let pushed = 0, pulled = 0, createdLocal = 0, createdRemote = 0;

  let issues: GithubIssue[] = [];
  try {
    const res = await opts.fetchImpl(`${apiRoot(opts)}/issues?state=all&per_page=100`, { headers: ghHeaders(opts.token) });
    if (!res.ok) return { direction: 'sync', dryRun: opts.dryRun ?? false, errors: [`list failed (HTTP ${res.status})`] };
    issues = ((await res.json()) as GithubIssue[]).filter((i) => !i.pull_request);
  } catch (e) {
    return { direction: 'sync', dryRun: opts.dryRun ?? false, errors: [(e as Error).message] };
  }

  const links = getGithubLinks(workspaceRoot);
  const itemIdByNumber = new Map<number, string>();
  for (const [wid, link] of Object.entries(links)) itemIdByNumber.set(link.number, wid);
  const handled = new Set<string>();
  const stamp = new Date().toISOString();

  // 1. Reconcile every GitHub issue against its linked (or key-matched) local item.
  for (const issue of issues) {
    try {
      for (const l of labelColors(issue.labels)) {
        if (l.color) upsertLabel(workspaceRoot, { name: l.name, color: l.color, externalSource: 'github' });
      }
      const keyFromMarker = keyFromBody(issue.body);
      const linkedId = itemIdByNumber.get(issue.number);
      const item = (linkedId ? getWorkItem(workspaceRoot, linkedId) : undefined)
        ?? (keyFromMarker ? getWorkItem(workspaceRoot, keyFromMarker) : undefined);

      if (!item) {
        if (opts.dryRun) { createdLocal++; continue; }
        const mapped = issueToWorkItem(issue, project);
        const created = createWorkItem(workspaceRoot, { ...mapped.input, actor: 'agent' });
        setGithubLink(workspaceRoot, created.id, {
          number: issue.number, url: issue.html_url ?? '',
          baseline: snapshotFromIssue(issue), githubUpdatedAt: issue.updated_at, syncedAt: stamp,
        });
        handled.add(created.id);
        createdLocal++;
        pulled += await pullComments(workspaceRoot, opts, created.id, issue.number, errors);
        continue;
      }

      handled.add(item.id);
      const outcome = mergePair(links[item.id]?.baseline, snapshotFromItem(item), snapshotFromIssue(issue));

      if (opts.dryRun) {
        if (Object.keys(outcome.pull).length) pulled++;
        if (outcome.push && !outcome.conflicts.length) pushed++;
        conflicts.push(...outcome.conflicts.map((f) => ({ key: item.key, field: f })));
        continue;
      }

      // Pull remote-only field changes (always safe — only the remote moved).
      if (Object.keys(outcome.pull).length) {
        updateWorkItem(workspaceRoot, item.id, snapshotToPatch(outcome.pull, project), 'agent');
        pulled += Object.keys(outcome.pull).length;
      }

      if (outcome.conflicts.length) {
        // Leave GitHub + the conflicting local fields untouched and DON'T advance
        // the baseline, so the conflict re-surfaces until the user reconciles.
        conflicts.push(...outcome.conflicts.map((f) => ({ key: item.key, field: f })));
      } else {
        if (outcome.push) {
          const res = await opts.fetchImpl(`${apiRoot(opts)}/issues/${issue.number}`, {
            method: 'PATCH', headers: ghHeaders(opts.token), body: JSON.stringify(snapshotToIssuePayload(outcome.merged, item.key)),
          });
          if (!res.ok) errors.push(`${item.key}: push failed (HTTP ${res.status})`);
          else pushed += 1;
        }
        setGithubLink(workspaceRoot, item.id, {
          number: issue.number, url: issue.html_url ?? links[item.id]?.url ?? '',
          baseline: outcome.merged, githubUpdatedAt: issue.updated_at, syncedAt: stamp,
        });
      }

      pushed += await pushComments(workspaceRoot, opts, item, issue.number, errors);
      pulled += await pullComments(workspaceRoot, opts, item.id, issue.number, errors);
    } catch (e) {
      errors.push(`#${issue.number}: ${(e as Error).message}`);
    }
  }

  // 2. Local items with no GitHub issue yet → create the issue (export path).
  for (const item of listWorkItems(workspaceRoot)) {
    if (handled.has(item.id) || links[item.id]) continue;
    if (opts.dryRun) { createdRemote++; continue; }
    try {
      const payload = workItemToIssue(item);
      const res = await opts.fetchImpl(`${apiRoot(opts)}/issues`, {
        method: 'POST', headers: ghHeaders(opts.token),
        body: JSON.stringify({ title: payload.title, body: payload.body, labels: payload.labels, assignees: payload.assignees }),
      });
      if (!res.ok) { errors.push(`${item.key}: create failed (HTTP ${res.status})`); continue; }
      const created = (await res.json()) as GithubIssue;
      if (payload.state === 'closed') {
        await opts.fetchImpl(`${apiRoot(opts)}/issues/${created.number}`, {
          method: 'PATCH', headers: ghHeaders(opts.token), body: JSON.stringify({ state: 'closed' }),
        });
      }
      setGithubLink(workspaceRoot, item.id, {
        number: created.number, url: created.html_url ?? '',
        baseline: snapshotFromItem(item), githubUpdatedAt: created.updated_at, syncedAt: stamp,
      });
      createdRemote++;
      pushed += await pushComments(workspaceRoot, opts, item, created.number, errors);
    } catch (e) {
      errors.push(`${item.key}: ${(e as Error).message}`);
    }
  }

  return {
    direction: 'sync', dryRun: opts.dryRun ?? false,
    pushed, pulled, created: { local: createdLocal, remote: createdRemote }, conflicts, errors,
  };
}

// ── Members from GitHub collaborators ─────────────────────────────────────────

/**
 * Map a GitHub collaborator's repo permission to a Track role:
 * admin → admin · maintain/write/push → member · everything else (triage/read)
 * → viewer. The repo never confers `owner` — that stays with the local operator.
 */
export function mapCollaboratorRole(c: GithubCollaborator): ProjectRole {
  const p = c.permissions ?? {};
  const r = c.role_name?.toLowerCase();
  if (p.admin || r === 'admin') return 'admin';
  if (p.maintain || p.push || r === 'maintain' || r === 'write') return 'member';
  return 'viewer';
}

export interface MemberSyncResult { members: ProjectMember[]; added: string[]; errors: string[] }

/**
 * Pull the repo's collaborators into the project's member roster (upserting by
 * login, role mapped from their repo permission). The seed owner (`you`) is left
 * untouched. With `dryRun`, fetches + reports who *would* be added, writing
 * nothing.
 */
export async function importMembersFromGithub(workspaceRoot: string, opts: SyncOptions): Promise<MemberSyncResult> {
  ensureProject(workspaceRoot);
  let collabs: GithubCollaborator[] = [];
  try {
    const res = await opts.fetchImpl(`${apiRoot(opts)}/collaborators?per_page=100`, { headers: ghHeaders(opts.token) });
    if (!res.ok) return { members: listMembers(workspaceRoot), added: [], errors: [`collaborators list failed (HTTP ${res.status})`] };
    collabs = (await res.json()) as GithubCollaborator[];
  } catch (e) {
    return { members: listMembers(workspaceRoot), added: [], errors: [(e as Error).message] };
  }

  const added: string[] = [];
  const errors: string[] = [];
  for (const c of collabs) {
    if (!c.login || c.login === LOCAL_MEMBER_ID) continue; // never overwrite the seed owner
    added.push(c.login);
    if (opts.dryRun) continue;
    try {
      addMember(workspaceRoot, { id: c.login, name: c.name ?? undefined, role: mapCollaboratorRole(c) });
    } catch (e) {
      errors.push(`${c.login}: ${(e as Error).message}`);
    }
  }
  return { members: listMembers(workspaceRoot), added, errors };
}
