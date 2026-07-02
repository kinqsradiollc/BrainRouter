/**
 * TRACK store — external sync links (GitHub issues).
 *
 * The persisted side-maps the GitHub sync bridge reads/writes: the work-item →
 * issue link table, the workspace's connector-first sync target, and the
 * one-time legacy-migration marker. Pure store accessors — the sync logic itself
 * lives in `githubSync.ts`.
 */
import { readTrack, writeTrack, nowIso } from './_internal.js';
import type { ExternalLink, GithubSyncTarget } from './types.js';

/** The recorded external links, keyed by work-item id. Used by the GitHub sync. */
export function getGithubLinks(workspaceRoot: string): Record<string, ExternalLink> {
  return readTrack(workspaceRoot).githubLinks ?? {};
}

/** Record (or clear, with `null`) the GitHub issue a work item maps to. */
export function setGithubLink(workspaceRoot: string, workItemId: string, link: ExternalLink | null): void {
  const store = readTrack(workspaceRoot);
  if (!store.githubLinks) store.githubLinks = {};
  if (link) store.githubLinks[workItemId] = link;
  else delete store.githubLinks[workItemId];
  writeTrack(workspaceRoot, store);
}

/** The workspace's connector-first GitHub sync target, if one has been chosen. */
export function getGithubSyncTarget(workspaceRoot: string): GithubSyncTarget | undefined {
  return readTrack(workspaceRoot).githubSyncTarget;
}

/** Set (or clear, with `null`) which connector + repo this workspace syncs with. */
export function setGithubSyncTarget(workspaceRoot: string, target: GithubSyncTarget | null): void {
  const store = readTrack(workspaceRoot);
  if (target) store.githubSyncTarget = { connectorId: target.connectorId, repo: target.repo };
  else delete store.githubSyncTarget;
  writeTrack(workspaceRoot, store);
}

/** One-time legacy-migration marker (see githubMigrate.ts). */
export function getGithubMigratedAt(workspaceRoot: string): string | undefined {
  return readTrack(workspaceRoot).githubMigratedAt;
}

export function markGithubMigrated(workspaceRoot: string, at = nowIso()): void {
  const store = readTrack(workspaceRoot);
  store.githubMigratedAt = at;
  writeTrack(workspaceRoot, store);
}
