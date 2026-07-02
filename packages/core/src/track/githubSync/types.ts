/**
 * TRACK — external sync (GitHub Issues): shared type surface.
 *
 * The GitHub wire shapes (the minimal subset we read/write) plus the sync
 * engine's option/result/config types. Moved verbatim out of the original
 * god file so the split modules can share one canonical set of shapes.
 */
import type { ProjectMember } from '@kinqs/brainrouter-types';
import type { CreateWorkItemInput, UpdateWorkItemPatch } from '../trackStore.js';

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

export interface MappedIssue {
  /** Work-item key parsed from the body marker, if this issue came from us. */
  key?: string;
  input: CreateWorkItemInput;
  /** The subset to apply when updating an existing item. */
  patch: UpdateWorkItemPatch & { labels?: string[] };
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
export interface ResolvedGithubConfig {
  repo?: string;
  token?: string;
  tokenSource?: GithubTokenSource;
  connectorId?: string;
  /**
   * Set when the workspace's chosen sync target can't be resolved (connector
   * removed/paused). Callers surface this instead of silently falling back to
   * some other repo — a sync against the wrong repo is worse than no sync.
   */
  error?: string;
}
export interface ResolvedGithubRepoSummary {
  repo: string;
  hasToken: boolean;
  tokenSource?: GithubTokenSource;
  active: boolean;
  label?: string;
  connectorId?: string;
  source?: 'track' | 'connector';
}

export interface MemberSyncResult { members: ProjectMember[]; added: string[]; errors: string[] }
