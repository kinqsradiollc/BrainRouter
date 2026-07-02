/**
 * TRACK — external sync (GitHub Issues): the REST client surface.
 *
 * URL builders + auth headers over the injected `fetch`, plus the comment
 * push/pull calls (the only sub-resource sync that touches the store as it
 * records the id-mapping so comments never re-push or re-import).
 */
import type { WorkItem } from '@kinqs/brainrouter-types';
import { getWorkItem, addComment, recordCommentSync } from '../trackStore.js';
import type { GithubComment, SyncOptions } from './types.js';

export function ghHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}

export function apiRoot(opts: SyncOptions): string {
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
export async function pushComments(workspaceRoot: string, opts: SyncOptions, item: WorkItem, issueNumber: number, errors: string[]): Promise<number> {
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
export async function pullComments(workspaceRoot: string, opts: SyncOptions, itemId: string, issueNumber: number, errors: string[]): Promise<number> {
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
