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
 *
 * This file is a thin re-export barrel; the implementation lives in the
 * `./githubSync/` sibling modules (types · mapping · config · client · sync).
 */

// ── GitHub shapes + sync-engine types ─────────────────────────────────────────
export type {
  GithubUser,
  GithubIssue,
  GithubComment,
  GithubIssuePayload,
  GithubCollaborator,
  FetchLike,
  MappedIssue,
  SyncOptions,
  ExportPlanEntry,
  ImportPlanEntry,
  SyncResult,
  GithubRepoConfig,
  GithubTokenSource,
  ResolvedGithubConfig,
  ResolvedGithubRepoSummary,
  MemberSyncResult,
} from './githubSync/types.js';

// ── Pure mapping (work item ↔ issue, snapshots) ───────────────────────────────
export {
  keyMarker,
  keyFromBody,
  workItemToIssue,
  issueToWorkItem,
  snapshotFromItem,
  snapshotFromIssue,
} from './githubSync/mapping.js';

// ── Repo + token resolution ───────────────────────────────────────────────────
export {
  normalizeGithubRepos,
  listResolvedGithubConfigs,
  resolveGithubConfig,
  listResolvedGithubConfigsForWorkspace,
  resolveGithubConfigForWorkspace,
} from './githubSync/config.js';

// ── Sync engine (export · import · bidirectional · members) ───────────────────
export {
  exportToGithub,
  importFromGithub,
  syncBidirectional,
  mapCollaboratorRole,
  importMembersFromGithub,
} from './githubSync/sync.js';
