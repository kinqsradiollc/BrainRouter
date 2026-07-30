/**
 * TRACK — external sync (GitHub Issues): the push/pull/reconcile engine.
 *
 * The stateful orchestration that ties the pure mapping (`./mapping.js`) and the
 * REST client (`./client.js`) to the Track store: one-way export, one-way
 * import, the bidirectional 3-way-merge sync, and the members-from-collaborators
 * pull. Everything takes the injected `fetch`, so it runs offline in tests.
 */
import type { ProjectRole } from '@kinqs/brainrouter-types';
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
  upsertLabel,
  LOCAL_MEMBER_ID,
} from '../trackStore.js';
import type {
  GithubIssue,
  GithubCollaborator,
  SyncOptions,
  ExportPlanEntry,
  ImportPlanEntry,
  SyncResult,
  MemberSyncResult,
} from './types.js';
import {
  keyFromBody,
  labelColors,
  workItemToIssue,
  issueToWorkItem,
  snapshotFromItem,
  snapshotFromIssue,
  mergePair,
  snapshotToPatch,
  snapshotToIssuePayload,
} from './mapping.js';
import { ghHeaders, apiRoot, pushComments, pullComments } from './client.js';

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
