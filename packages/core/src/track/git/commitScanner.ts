/**
 * TRACK — BR-123 commit-message scanner.
 *
 * Closes the gap where code → Track provenance stalls because the agent forgot
 * to call `track_update link`: parse `<KEY>-<n>` references out of commit
 * messages and link each commit to its work item (deduped) + advance todo →
 * in-progress, exactly like the code-signal automation but driven by the git
 * history instead of an explicit tool call. Pure over the store; the git read is
 * a thin, swappable `spawnSync` helper so the scan logic is unit-testable.
 */
import { spawnSync } from 'node:child_process';
import { getProject, ensureProject, getWorkItem, linkWorkItem, transitionWorkItem } from '../trackStore.js';
import { isUnstartedCategory, type TrackProject } from '@kinqs/brainrouter-types';

export interface ScannedCommit { sha: string; subject: string; body?: string }

export interface CommitScanResult {
  scanned: number;
  linked: Array<{ sha: string; key: string; workItemKey: string }>;
  transitioned: Array<{ key: string; from: string; to: string }>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the work-item keys a commit message references, e.g. "BR-123".
 * Strict `<projectKey>-<digits>` with word boundaries (so "ABR-1" or a bare
 * "123" don't match), case-insensitive on the prefix, normalized to the
 * project's canonical casing + deduped in first-seen order.
 */
export function parseCommitKeys(message: string, projectKey: string): string[] {
  const key = projectKey.trim();
  if (!key || !message) return [];
  const re = new RegExp(`\\b${escapeRegex(key)}-(\\d+)\\b`, 'gi');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of message.matchAll(re)) {
    const normalized = `${key}-${Number(m[1])}`;
    if (!seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  return out;
}

/** The in-progress workflow state a commit advances a `todo` item into. */
function inProgressState(project: TrackProject): { id: string } | undefined {
  return project.workflowStates.find((s) => s.id === 'in-progress')
    ?? project.workflowStates.find((s) => s.category === 'started');
}

/**
 * Link a batch of commits to their referenced work items and advance todo
 * items. Idempotent: a commit already linked to an item (kind:'commit', same
 * sha) is skipped, and a re-scan is a no-op. Returns what changed.
 */
export function scanCommitsForTrack(workspaceRoot: string, commits: ScannedCommit[]): CommitScanResult {
  const project = getProject(workspaceRoot) ?? ensureProject(workspaceRoot);
  const inProgress = inProgressState(project);
  const result: CommitScanResult = { scanned: commits.length, linked: [], transitioned: [] };

  for (const commit of commits) {
    const sha = commit.sha?.trim();
    if (!sha) continue;
    const keys = parseCommitKeys(`${commit.subject ?? ''}\n${commit.body ?? ''}`, project.key);
    for (const key of keys) {
      const item = getWorkItem(workspaceRoot, key);
      if (!item) continue;
      // Dedup: only link + report when this commit isn't already on the item.
      const already = item.codeLinks.some((c) => c.kind === 'commit' && c.ref.trim() === sha);
      if (!already) {
        linkWorkItem(workspaceRoot, item.id, { codeLinks: [{ kind: 'commit', ref: sha, label: commit.subject?.slice(0, 80) }] });
        result.linked.push({ sha, key, workItemKey: item.key });
      }
      // A commit is evidence work started: advance only from a not-started state.
      if (inProgress && isUnstartedCategory(item.statusCategory) && item.status !== inProgress.id) {
        const moved = transitionWorkItem(workspaceRoot, item.id, inProgress.id, 'agent');
        if (moved) result.transitioned.push({ key: item.key, from: item.status, to: moved.status });
      }
    }
  }
  return result;
}

export interface ReadCommitsOptions {
  /** Cap the history walked (default 50). */
  maxCount?: number;
  /** Only commits after this git revspec/date (e.g. "HEAD~20", "2026-06-01"). */
  since?: string;
}

/** Read recent commits from the workspace's git history (subject + body). */
export function readRecentCommits(workspaceRoot: string, options: ReadCommitsOptions = {}): ScannedCommit[] {
  const maxCount = Number.isInteger(options.maxCount) && options.maxCount! > 0 ? options.maxCount! : 50;
  // %x1f (unit sep) between fields, %x1e (record sep) between commits — robust to
  // newlines/spaces in messages.
  const args = ['-C', workspaceRoot, 'log', `--max-count=${maxCount}`, '--no-color', '--format=%H%x1f%s%x1f%b%x1e'];
  if (options.since?.trim()) args.push(`--since=${options.since.trim()}`);
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout.split('\x1e').map((rec) => rec.trim()).filter(Boolean).map((rec) => {
    const [sha, subject, body] = rec.split('\x1f');
    return { sha: (sha ?? '').trim(), subject: (subject ?? '').trim(), body: (body ?? '').trim() };
  }).filter((c) => c.sha);
}

/** Convenience: read recent git commits + reconcile them into Track. */
export function scanGitCommitsForTrack(workspaceRoot: string, options: ReadCommitsOptions = {}): CommitScanResult {
  return scanCommitsForTrack(workspaceRoot, readRecentCommits(workspaceRoot, options));
}
