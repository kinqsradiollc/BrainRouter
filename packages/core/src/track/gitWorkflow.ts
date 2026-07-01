import { spawnSync } from 'node:child_process';
import { isUnstartedCategory, type WorkItem, type TrackProject } from '@kinqs/brainrouter-types';
import { ensureProject, getProject, getWorkItem, linkWorkItem, transitionWorkItem } from './trackStore.js';

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  error?: string;
}

export type GitRunner = (args: string[], cwd: string) => GitCommandResult;

export interface GitTrackRemote {
  name: string;
  url: string;
  githubRepo?: string;
}

export interface GitTrackContext {
  ok: boolean;
  hasGit: boolean;
  root?: string;
  currentBranch?: string | null;
  remotes: GitTrackRemote[];
  githubRepo?: string;
  error?: string;
}

export interface StartGitWorkOptions {
  branchName?: string;
  createBranch?: boolean;
  actor?: string;
}

export interface StartGitWorkResult {
  ok: boolean;
  itemKey?: string;
  branch?: string;
  created?: boolean;
  switched?: boolean;
  transitioned?: { from: string; to: string };
  context?: GitTrackContext;
  item?: WorkItem;
  error?: string;
}

export function defaultGitRunner(args: string[], cwd: string): GitCommandResult {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 8_000_000 });
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  const status = typeof res.status === 'number' ? res.status : null;
  const error = res.error ? res.error.message : undefined;
  return { ok: status === 0 && !error, stdout, stderr, status, error };
}

export function parseGitHubRemote(url: string): { owner: string; repo: string; slug: string } | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  const https = raw.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const ssh = raw.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const match = https ?? ssh;
  if (!match) return undefined;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!owner || !repo) return undefined;
  return { owner, repo, slug: `${owner}/${repo}` };
}

export function slugifyBranchPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'work';
}

export function branchNameForWorkItem(item: Pick<WorkItem, 'key' | 'title'>): string {
  return `track/${item.key.toLowerCase()}-${slugifyBranchPart(item.title)}`;
}

function parseRemotes(stdout: string): GitTrackRemote[] {
  const byName = new Map<string, GitTrackRemote>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== 'fetch') continue;
    const github = parseGitHubRemote(match[2]);
    byName.set(match[1], { name: match[1], url: match[2], githubRepo: github?.slug });
  }
  return [...byName.values()];
}

export function readGitTrackContext(workspaceRoot: string, runner: GitRunner = defaultGitRunner): GitTrackContext {
  const rootRes = runner(['rev-parse', '--show-toplevel'], workspaceRoot);
  if (!rootRes.ok) {
    return {
      ok: false,
      hasGit: false,
      remotes: [],
      error: rootRes.error ?? rootRes.stderr.trim() ?? 'Workspace is not inside a Git repository.',
    };
  }
  const root = rootRes.stdout.trim();
  const branchRes = runner(['branch', '--show-current'], root);
  const remoteRes = runner(['remote', '-v'], root);
  const remotes = remoteRes.ok ? parseRemotes(remoteRes.stdout) : [];
  const githubRepo = remotes.find((remote) => remote.githubRepo)?.githubRepo;
  return {
    ok: true,
    hasGit: true,
    root,
    currentBranch: branchRes.ok ? branchRes.stdout.trim() || null : null,
    remotes,
    githubRepo,
  };
}

function inProgressState(project: TrackProject): { id: string } | undefined {
  return project.workflowStates.find((s) => s.id === 'in-progress')
    ?? project.workflowStates.find((s) => s.category === 'started');
}

function gitError(result: GitCommandResult, fallback: string): string {
  return result.error ?? result.stderr.trim() ?? result.stdout.trim() ?? fallback;
}

export function startGitWorkForTrackItem(
  workspaceRoot: string,
  idOrKey: string,
  options: StartGitWorkOptions = {},
  runner: GitRunner = defaultGitRunner,
): StartGitWorkResult {
  const project = getProject(workspaceRoot) ?? ensureProject(workspaceRoot);
  const item = getWorkItem(workspaceRoot, idOrKey);
  if (!item) return { ok: false, error: `Unknown work item "${idOrKey}".` };

  const context = readGitTrackContext(workspaceRoot, runner);
  if (!context.ok || !context.root) return { ok: false, context, error: context.error ?? 'Workspace is not inside a Git repository.' };

  const createBranch = options.createBranch !== false;
  const branch = createBranch
    ? (options.branchName?.trim() || branchNameForWorkItem(item))
    : (context.currentBranch || options.branchName?.trim() || branchNameForWorkItem(item));

  const valid = runner(['check-ref-format', '--branch', branch], context.root);
  if (!valid.ok) return { ok: false, context, branch, error: gitError(valid, `Invalid Git branch name "${branch}".`) };

  let created = false;
  let switched = false;
  if (createBranch && context.currentBranch !== branch) {
    const exists = runner(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], context.root).ok;
    const checkout = exists
      ? runner(['checkout', branch], context.root)
      : runner(['checkout', '-b', branch], context.root);
    if (!checkout.ok) return { ok: false, context, branch, error: gitError(checkout, `Could not switch to branch "${branch}".`) };
    created = !exists;
    switched = true;
  }

  let updated = linkWorkItem(workspaceRoot, item.id, { codeLinks: [{ kind: 'branch', ref: branch, label: context.githubRepo ?? 'local git' }] }) ?? item;
  let transitioned: StartGitWorkResult['transitioned'];
  const inProgress = inProgressState(project);
  if (inProgress && isUnstartedCategory(updated.statusCategory) && updated.status !== inProgress.id) {
    const moved = transitionWorkItem(workspaceRoot, updated.id, inProgress.id, options.actor ?? 'user');
    if (moved) {
      transitioned = { from: updated.status, to: moved.status };
      updated = moved;
    }
  }

  return {
    ok: true,
    itemKey: updated.key,
    branch,
    created,
    switched,
    transitioned,
    context: switched ? { ...context, currentBranch: branch } : context,
    item: updated,
  };
}
