/**
 * TRACK — external sync (GitHub Issues): repo + token resolution.
 *
 * No secrets are stored here — these functions read the workspace's connectors
 * and the `cli.track.*` knobs (with the standard `GITHUB_TOKEN`/`GH_TOKEN` env
 * fallback) to resolve WHICH repo to sync and WHICH token to use. The sync
 * engine takes the resolved repo/token as plain arguments.
 */
import { getRawCliKnobs } from '../../config/config.js';
import { listConnectors } from '../../connectors/stores/connectorStore.js';
import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import { getGithubSyncTarget } from '../trackStore.js';
import type {
  GithubRepoConfig,
  GithubTokenSource,
  ResolvedGithubConfig,
  ResolvedGithubRepoSummary,
} from './types.js';

function envGithubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

/** Legacy `cli.track.github*` knob entries, normalized (also used by githubMigrate). */
export function normalizeGithubRepos(knobs: NonNullable<ReturnType<typeof getRawCliKnobs>['track']>): GithubRepoConfig[] {
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
  tokenSource?: GithubTokenSource;
}

/**
 * Resolve a connector's static credential for a given repo. `credential.ref`
 * schemes:
 *   - `config:track` — the migrated-legacy scheme: the token still lives in the
 *     global `cli.track.*` knobs (per-repo entry token, else `githubToken`).
 *     Phase 3 moves this into the OS keychain; until then the plaintext stays
 *     exactly where it already was — no new exposure.
 *   - anything else — a host environment variable name (original behavior).
 */
function connectorToken(connector: ConnectorRecord, repo?: string): { token?: string; source?: GithubTokenSource } {
  if (connector.credential?.mode !== 'static') return {};
  const ref = connector.credential.ref?.trim();
  if (!ref) return {};
  if (ref === 'config:track') {
    const knobs = getRawCliKnobs().track ?? {};
    const entry = repo ? normalizeGithubRepos(knobs).find((r) => r.repo === repo) : undefined;
    const token = entry?.token?.trim() || knobs.githubToken?.trim() || undefined;
    return token ? { token, source: 'config' } : {};
  }
  const token = process.env[ref]?.trim();
  return token ? { token, source: 'connector-env' } : {};
}

/**
 * Every (connector, repo) pair configured in this workspace. Deliberately NOT
 * deduplicated by repo name: two connectors (two identities) may both own
 * `acme/core`, and dropping one silently made the second connector look dead.
 * Callers disambiguate with `connectorId`.
 */
function connectorGithubRepos(workspaceRoot: string): ConnectorGithubRepoConfig[] {
  const rows: ConnectorGithubRepoConfig[] = [];
  for (const connector of listConnectors(workspaceRoot, { source: 'github' })) {
    if (connector.status === 'deleting' || connector.status === 'paused') continue;
    const owner = typeof connector.config.owner === 'string' ? connector.config.owner.trim().replace(/^\/+|\/+$/g, '') : '';
    const rawRepos = Array.isArray(connector.config.repositories)
      ? connector.config.repositories.filter((repo): repo is string => typeof repo === 'string' && repo.trim().length > 0)
      : [];
    // Empty repositories = "all under the owner" (ingest-only); Track sync needs
    // an explicit target repo, so those connectors contribute no rows here.
    if (rawRepos.length === 0) continue;
    const seen = new Set<string>();
    for (const rawRepo of rawRepos) {
      const repoName = rawRepo.trim().replace(/^\/+|\/+$/g, '');
      const repo = repoName.includes('/') ? repoName : (owner ? `${owner}/${repoName}` : '');
      if (!repo || seen.has(repo)) continue;
      seen.add(repo);
      const cred = connectorToken(connector, repo);
      rows.push({
        repo,
        label: connector.name,
        connectorId: connector.id,
        token: cred.token,
        tokenSource: cred.source,
      });
    }
  }
  return rows;
}

export function listResolvedGithubConfigsForWorkspace(workspaceRoot: string): ResolvedGithubRepoSummary[] {
  const target = getGithubSyncTarget(workspaceRoot);
  const trackRows = listResolvedGithubConfigs().map((row): ResolvedGithubRepoSummary => ({ ...row, source: 'track' }));
  const connectorRows = connectorGithubRepos(workspaceRoot);

  // One row per (connector, repo) pair. A legacy track row merges into a
  // connector row only when there is exactly ONE connector offering that repo
  // (the migrated / single-identity case); with two identities on the same
  // repo, each keeps its own row so the picker can disambiguate.
  const rows: ResolvedGithubRepoSummary[] = [];
  const connectorsByRepo = new Map<string, ConnectorGithubRepoConfig[]>();
  for (const entry of connectorRows) {
    const list = connectorsByRepo.get(entry.repo) ?? [];
    list.push(entry);
    connectorsByRepo.set(entry.repo, list);
  }
  const mergedTrackRepos = new Set<string>();
  for (const entry of connectorRows) {
    const track = trackRows.find((row) => row.repo === entry.repo);
    const mergeTrack = !!track && (connectorsByRepo.get(entry.repo)?.length ?? 0) === 1;
    if (mergeTrack) mergedTrackRepos.add(entry.repo);
    rows.push({
      repo: entry.repo,
      hasToken: !!entry.token || (mergeTrack ? track!.hasToken : false),
      tokenSource: entry.token ? entry.tokenSource : (mergeTrack ? track!.tokenSource : undefined),
      active: false,
      label: entry.label,
      connectorId: entry.connectorId,
      source: 'connector',
    });
  }
  for (const row of trackRows) {
    if (!mergedTrackRepos.has(row.repo) && !connectorsByRepo.has(row.repo)) rows.push(row);
  }

  // Active: the workspace's chosen (connector, repo) target wins; otherwise the
  // legacy active repo; otherwise the first row.
  let activeIdx = target
    ? rows.findIndex((row) => row.connectorId === target.connectorId && row.repo === target.repo)
    : -1;
  if (activeIdx < 0) activeIdx = rows.findIndex((row) => row.source === 'track' && row.active);
  if (activeIdx < 0 && !target) activeIdx = rows.findIndex((row) => row.active);
  if (activeIdx < 0 && rows.length > 0) activeIdx = 0;
  return rows.map((row, i) => ({ ...row, active: i === activeIdx }));
}

export function resolveGithubConfigForWorkspace(workspaceRoot: string, repoArg?: string, tokenArg?: string): ResolvedGithubConfig {
  // Connector-first: when this workspace chose a sync target, that connector is
  // authoritative. A missing/paused connector is an explicit error — syncing
  // against whatever else happens to be configured risks writing issues to the
  // wrong repo. Explicit args still override (CLI --repo/--token).
  const target = getGithubSyncTarget(workspaceRoot);
  if (target && !repoArg && !tokenArg) {
    const rows = connectorGithubRepos(workspaceRoot).filter((entry) => entry.connectorId === target.connectorId);
    if (rows.length === 0) {
      return { error: 'The GitHub connector this workspace syncs with was removed or paused. Pick a repo in Settings → Connectors → GitHub.' };
    }
    const row = rows.find((entry) => entry.repo === target.repo) ?? rows[0];
    const token = row.token || envGithubToken();
    return {
      repo: row.repo,
      token,
      tokenSource: row.token ? row.tokenSource : (token ? 'env' : undefined),
      connectorId: target.connectorId,
    };
  }

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
