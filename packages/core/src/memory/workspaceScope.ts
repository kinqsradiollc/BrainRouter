/**
 * Every identity this workspace's memories are filed under.
 *
 * One checkout, two tags. Chat turns are captured under the hash of the
 * folder path; an ingested repository is captured under the hash of its git
 * remote (ADR-015), so it survives a moved folder or a second clone. A recall
 * that knows only the first labels the repository's own ingested files as
 * belonging to "another workspace" — or, under a hard filter, drops them from
 * their own repo's recall entirely. So the client sends both, and the brain
 * treats either as "here".
 *
 * The path hash uses the root exactly as capture sends it (no realpath), so
 * the two sides hash the same string. The remote costs two `git` calls, so it
 * is cached; a remote added mid-session is picked up within the TTL.
 */
import { workspaceTagFromPath } from '@kinqs/brainrouter-types';
import { resolveWorkspaceGit } from '../git/workspaceGit.js';

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { tags: string[]; at: number }>();

export function workspaceMemoryTags(
  workspaceRoot: string | null | undefined,
  now: number = Date.now(),
): string[] {
  const root = (workspaceRoot ?? '').trim();
  if (!root) return [];
  const hit = cache.get(root);
  if (hit && now - hit.at < TTL_MS) return hit.tags;

  const tags: string[] = [];
  const pathTag = workspaceTagFromPath(root);
  if (pathTag) tags.push(pathTag);
  try {
    const { repoTag } = resolveWorkspaceGit(root);
    if (repoTag && !tags.includes(repoTag)) tags.push(repoTag);
  } catch {
    // No git, or git unavailable: the folder is the only identity it has.
  }
  cache.set(root, { tags, at: now });
  return tags;
}
