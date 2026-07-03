/**
 * TRACK — legacy GitHub-config → connector migration (connector Phase 0).
 *
 * Historically Track sync was configured twice: the global `cli.track.github*`
 * knobs (repo/repos/token) AND the workspace's GitHub connector. This one-time,
 * per-workspace migration makes the CONNECTOR the source of truth:
 *
 *   - ensure a GitHub connector exists carrying the legacy repo list
 *   - point the workspace's `githubSyncTarget` (track.json) at it
 *   - mark the workspace migrated so this never runs twice
 *
 * The global knobs are NOT deleted: connectors are workspace-scoped, so another
 * workspace that still relies on the legacy config keeps working (it migrates
 * itself the first time it syncs). The token also intentionally STAYS in
 * `cli.track.githubToken` for now — the migrated connector references it via the
 * `config:track` credential scheme, so there is no new plaintext exposure and
 * nothing to lose. Phase 3 moves the value into the OS keychain.
 *
 * Multi-token configs (different PATs per repo entry) are left alone: collapsing
 * them into one connector identity would silently drop credentials. Those users
 * keep the legacy path until they pick a target in Settings.
 */
import { getRawCliKnobs } from '../../config/config.js';
import { listConnectors, createConnector, updateConnector } from '../../connectors/connectorStore.js';
import { normalizeGithubRepos } from '../githubSync.js';
import { getGithubMigratedAt, markGithubMigrated, getGithubSyncTarget, setGithubSyncTarget } from '../trackStore.js';

export interface TrackGithubMigrationResult {
  migrated: boolean;
  reason: string;
  connectorId?: string;
  repo?: string;
}

export function migrateTrackGithubToConnector(workspaceRoot: string): TrackGithubMigrationResult {
  if (getGithubMigratedAt(workspaceRoot)) return { migrated: false, reason: 'already migrated' };
  if (getGithubSyncTarget(workspaceRoot)) {
    // The workspace already chose a connector target — nothing legacy to adopt.
    markGithubMigrated(workspaceRoot);
    return { migrated: false, reason: 'target already set' };
  }

  const knobs = getRawCliKnobs().track ?? {};
  const legacy = normalizeGithubRepos(knobs);
  if (legacy.length === 0) {
    markGithubMigrated(workspaceRoot);
    return { migrated: false, reason: 'no legacy github config' };
  }

  const distinctTokens = new Set(legacy.map((r) => r.token).filter((t): t is string => !!t));
  if (knobs.githubToken?.trim()) distinctTokens.add(knobs.githubToken.trim());
  if (distinctTokens.size > 1) {
    // Don't guess which credential wins — leave the legacy path in place.
    return { migrated: false, reason: 'multiple distinct legacy tokens — pick a target in Settings → Connectors' };
  }
  const hasToken = distinctTokens.size === 1;

  const activeRepo = knobs.activeGithubRepo?.trim() || knobs.githubRepo?.trim() || legacy[0].repo;
  const repos = legacy.map((r) => r.repo);

  // Reuse an existing GitHub connector when possible (union its repo list);
  // otherwise create one that mirrors the legacy setup.
  const existing = listConnectors(workspaceRoot, { source: 'github' })
    .filter((c) => c.status !== 'deleting')
    .sort((a, b) => (a.status === 'paused' ? 1 : 0) - (b.status === 'paused' ? 1 : 0))[0];

  let connectorId: string;
  if (existing) {
    const current = Array.isArray(existing.config.repositories)
      ? existing.config.repositories.filter((r): r is string => typeof r === 'string')
      : [];
    const merged = [...new Set([...current, ...repos])];
    const patch: Parameters<typeof updateConnector>[2] = { config: { ...existing.config, repositories: merged } };
    // Only claim the credential slot if the connector has none of its own.
    if (hasToken && (existing.credential?.mode === 'none' || !existing.credential)) {
      patch.credential = { mode: 'static', ref: 'config:track' };
    }
    updateConnector(workspaceRoot, existing.id, patch);
    connectorId = existing.id;
  } else {
    const created = createConnector(workspaceRoot, {
      source: 'github',
      name: 'GitHub (migrated from Track sync)',
      config: { repositories: repos, includeIssues: true, includePullRequests: true, includeFiles: false },
      credential: hasToken ? { mode: 'static', ref: 'config:track' } : { mode: 'dynamic' },
    });
    connectorId = created.id;
  }

  const repo = repos.includes(activeRepo) ? activeRepo : repos[0];
  setGithubSyncTarget(workspaceRoot, { connectorId, repo });
  markGithubMigrated(workspaceRoot);
  return { migrated: true, reason: 'migrated legacy cli.track.github config', connectorId, repo };
}
