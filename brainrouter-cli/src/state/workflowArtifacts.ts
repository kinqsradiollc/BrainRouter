import fs from 'node:fs';
import path from 'node:path';
import { getCliStateFile, getSessionStateFile, getWorkspaceLocalDir, isPathInside, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Canonical home for durable workflow artifacts produced by the multi-agent
 * commands (/feature-dev, /spec, /review, /implement-plan).
 *
 * One workflow == one slug == one directory:
 *   <workspace>/.brainrouter/workflows/<slug>/
 *     spec.md         — the agreed specification (what + why + boundaries)
 *     tasks.md        — human-readable task breakdown for execution
 *     walkthrough.md  — post-implementation summary (what was built, where)
 *     meta.json       — { slug, title, kind, createdAt, updatedAt, status }
 *     notes/          — optional supplementary artifacts (explorer reports etc.)
 *
 * Workflows are the ONLY thing brainrouter writes inside the workspace. They
 * stay here because (a) they're meant to be committed alongside code so the
 * team shares them, and (b) the agent's `write_file` tool only accepts paths
 * relative to the workspace root. Personal CLI state (sessions, hooks,
 * memories, preferences) lives in `~/.brainrouter/workspaces/<encoded>/` and
 * never touches the project tree. The current-workflow pointer is still per-
 * user (it tracks which workflow YOU are focused on right now) so it lives
 * with the CLI state, not the workspace.
 */

const WORKFLOWS_SUBDIR = 'workflows';
/**
 * Workspace-level "last used workflow" pointer. Pre-9d-bugfix this was
 * BOTH the source of truth for "which workflow is the current CLI
 * session bound to" AND the display-only "what was the last workflow
 * touched in this workspace" hint. The two responsibilities are now
 * split: this file is the hint (any CLI in this workspace can see it),
 * while `SESSION_POINTER_FILE` carries the per-session binding that
 * actually drives goal scoping. The hint is still useful for the
 * `/workflows` listing and for surfacing "you were last on X" in a
 * fresh CLI without auto-binding it to that workflow's goal.
 */
const CURRENT_POINTER_FILE = 'current-workflow.json';
/**
 * Per-session workflow binding (the actual source of truth for goal
 * scoping). Lives under the session state directory so two CLIs in the
 * same workspace can have independent workflows bound — fixes the
 * "session A's `/feature-dev` automatically becomes session B's active
 * workflow + active goal" leak that reintroduced Item 1's cross-session
 * leak via the Item 3 workspace pointer.
 */
const SESSION_POINTER_FILE = 'workflow.json';

export interface WorkflowMeta {
  slug: string;
  title: string;
  kind: 'feature-dev' | 'spec' | 'review' | 'implement-plan' | string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'awaiting-approval' | 'in-progress' | 'completed' | 'closed';
}

/** Canonical artifact names. Use the constants rather than hard-coded strings so a future rename is one edit. */
export const ARTIFACT = {
  spec: 'spec.md',
  tasks: 'tasks.md',
  walkthrough: 'walkthrough.md',
} as const;

export function slugify(input: string, fallback = 'workflow'): string {
  const base = (input ?? '').toString().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return base || fallback;
}

export function getWorkflowsRoot(workspaceRoot: string): string {
  const wsLocal = getWorkspaceLocalDir(workspaceRoot);
  const root = path.join(wsLocal, WORKFLOWS_SUBDIR);
  if (!isPathInside(wsLocal, root)) {
    throw new Error('Workflows root escapes workspace-local directory.');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function getWorkflowDir(workspaceRoot: string, slug: string): string {
  const safeSlug = slugify(slug);
  const root = getWorkflowsRoot(workspaceRoot);
  const dir = path.join(root, safeSlug);
  if (!isPathInside(root, dir)) {
    throw new Error(`Workflow slug "${slug}" escapes workflows root.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create (or reopen) a workflow folder + bind it as the current
 * workflow.
 *
 * `sessionKey` is threaded through to `setCurrentWorkflow` so that the
 * created workflow is bound to THIS session (not to every other CLI
 * session in the workspace via the workspace-level pointer). Legacy
 * callers without a session context fall through to workspace-level
 * binding only — same back-compat path `setCurrentWorkflow` provides.
 */
export function createWorkflow(
  workspaceRoot: string,
  input: { title: string; kind: WorkflowMeta['kind']; slug?: string; sessionKey?: string },
): WorkflowMeta {
  const slug = slugify(input.slug ?? input.title);
  const dir = getWorkflowDir(workspaceRoot, slug);
  const metaPath = path.join(dir, 'meta.json');
  const now = new Date().toISOString();
  const existing = readJsonFile<WorkflowMeta | null>(metaPath, null);
  const meta: WorkflowMeta = existing ?? {
    slug,
    title: input.title,
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
    status: 'draft',
  };
  meta.updatedAt = now;
  // If meta exists, keep its createdAt but allow title/kind drift only when the caller explicitly differs.
  if (existing) {
    if (input.title) meta.title = input.title;
    if (input.kind) meta.kind = input.kind;
  }
  writeJsonFile(metaPath, meta);
  setCurrentWorkflow(workspaceRoot, slug, input.sessionKey);
  return meta;
}

export function updateWorkflowStatus(
  workspaceRoot: string,
  slug: string,
  status: WorkflowMeta['status'],
): WorkflowMeta | undefined {
  const dir = getWorkflowDir(workspaceRoot, slug);
  const metaPath = path.join(dir, 'meta.json');
  const existing = readJsonFile<WorkflowMeta | null>(metaPath, null);
  if (!existing) return undefined;
  existing.status = status;
  existing.updatedAt = new Date().toISOString();
  writeJsonFile(metaPath, existing);
  return existing;
}

export function listWorkflows(workspaceRoot: string): WorkflowMeta[] {
  const root = getWorkflowsRoot(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const out: WorkflowMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(root, entry.name, 'meta.json');
    const meta = readJsonFile<WorkflowMeta | null>(metaPath, null);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * Bind a workflow to the current CLI session AND update the workspace-
 * level "last used" hint. When `sessionKey` is omitted (legacy callers,
 * some first-run paths), only the workspace pointer is written — those
 * callers don't have a session context yet, so per-session binding
 * doesn't apply.
 *
 * The workspace pointer is updated unconditionally because we still
 * want a fresh CLI in the same workspace to be ABLE to see "X is the
 * last workflow that was touched here" — for display via
 * `getLastUsedWorkflow`, for the `/workflows` listing's `★` marker, and
 * for the post-9d "do you want to switch to <X>?" UX (the latter not
 * yet shipped, tracked separately).
 */
export function setCurrentWorkflow(workspaceRoot: string, slug: string, sessionKey?: string): void {
  const ts = new Date().toISOString();
  writeJsonFile(getCliStateFile(workspaceRoot, CURRENT_POINTER_FILE), { slug, at: ts });
  if (sessionKey) {
    writeJsonFile(getSessionStateFile(workspaceRoot, sessionKey, SESSION_POINTER_FILE), { slug, at: ts });
  }
}

/**
 * Which workflow is bound to THIS CLI session?
 *
 * - With `sessionKey`: reads ONLY the session-level pointer. A fresh
 *   CLI session has no session-level pointer → returns `undefined`,
 *   even when a workspace-level "last used" hint exists. This is the
 *   load-bearing fix: new sessions don't auto-inherit another session's
 *   workflow binding (which previously dragged that workflow's goal
 *   into the new session via `resolveGoalScope`).
 * - Without `sessionKey` (legacy / display-only callers): falls back
 *   to the workspace-level pointer for back-compat.
 *
 * Display surfaces that want to show "the last workflow touched here,
 * regardless of session binding" should call `getLastUsedWorkflow`
 * instead so the distinction stays explicit.
 */
export function getCurrentWorkflow(workspaceRoot: string, sessionKey?: string): string | undefined {
  if (sessionKey) {
    const sessionPtr = readJsonFile<{ slug?: string } | null>(
      getSessionStateFile(workspaceRoot, sessionKey, SESSION_POINTER_FILE),
      null,
    );
    return sessionPtr?.slug || undefined;
  }
  const ptr = readJsonFile<{ slug?: string } | null>(getCliStateFile(workspaceRoot, CURRENT_POINTER_FILE), null);
  return ptr?.slug;
}

/**
 * Display-only "last workflow used in this workspace" lookup. Reads
 * the workspace-level pointer unconditionally — never consults the
 * session-level binding. Use when you want to render a hint like
 * "you were last on workflow X" without implying that the current
 * session is bound to it.
 */
export function getLastUsedWorkflow(workspaceRoot: string): string | undefined {
  const ptr = readJsonFile<{ slug?: string } | null>(getCliStateFile(workspaceRoot, CURRENT_POINTER_FILE), null);
  return ptr?.slug;
}

/**
 * Clear the session-level workflow binding (workspace-level hint
 * preserved). Used by `/new` and `/fork` so a freshly-forked session
 * doesn't drag the parent's binding along.
 */
export function clearSessionWorkflow(workspaceRoot: string, sessionKey: string): void {
  const pointerPath = getSessionStateFile(workspaceRoot, sessionKey, SESSION_POINTER_FILE);
  try { fs.unlinkSync(pointerPath); } catch { /* idempotent — no file to remove is fine */ }
}

/**
 * Path to a workflow's bound `goal.json`. The goal lives ALONGSIDE
 * `meta.json` / `spec.md` inside the workflow folder so that switching
 * workflows carries the goal with it (Item 3 of the 0.3.6 cycle). When no
 * workflow is bound, callers fall back to the per-session goal path —
 * `resolveGoalScope` in goalStore.ts owns that fall-through.
 *
 * Pattern adapted from openSrc/bruno/packages/bruno-schema/src/collections/
 * — Bruno keeps the active-environment scalar inside the collection doc
 * rather than in a separate workspace-tree pointer, which avoids the stale-
 * pointer race we'd hit if `current-workflow.json` and `<workflow>/goal.json`
 * drifted. (The per-user current-workflow pointer is intentionally kept in
 * CLI state — it's per-user-per-machine, not part of the committed workflow.)
 */
export function getWorkflowGoalFile(workspaceRoot: string, slug: string): string {
  return path.join(getWorkflowDir(workspaceRoot, slug), 'goal.json');
}

/**
 * True iff a workflow folder with the given slug exists (and carries a
 * meta.json). Used by `/workflow switch <slug>` to surface "no such
 * workflow" without the side-effect mkdir that `getWorkflowDir` performs.
 */
export function workflowExists(workspaceRoot: string, slug: string): boolean {
  const safeSlug = slugify(slug);
  const root = getWorkflowsRoot(workspaceRoot);
  const candidate = path.join(root, safeSlug, 'meta.json');
  return fs.existsSync(candidate);
}

/**
 * Lightweight conflict probe used by /feature-dev, /spec, /review BEFORE
 * they call createWorkflow. When the current pointer points at a DIFFERENT
 * workflow whose goal is `active`, returns the slug + a short summary so
 * the slash handler can askYesNo before clobbering it.
 *
 * Reads goal.json directly (not through goalStore.readWorkflowGoal) to
 * avoid a workflowArtifacts → goalStore import cycle. The fields we need
 * (status + text) are stable across the Goal schema's lifetime, so the
 * narrow shape on disk is fine here.
 */
export interface CreateWorkflowConflict {
  currentSlug: string;
  currentGoalStatus: string;
  currentGoalText: string;
}

export function detectCreateWorkflowConflict(
  workspaceRoot: string,
  newSlugOrTitle: string,
  sessionKey?: string,
): CreateWorkflowConflict | null {
  // 9d-bugfix: scope the "current workflow" lookup to the calling
  // session. A fresh CLI session that never bound a workflow has no
  // conflict — only an already-bound session needs the prompt.
  const currentSlug = getCurrentWorkflow(workspaceRoot, sessionKey);
  if (!currentSlug) return null;
  // Creating "the workflow you're already on" is a no-op for the pointer —
  // no clobber to prompt about.
  const newSlug = slugify(newSlugOrTitle);
  if (currentSlug === newSlug) return null;
  const goalPath = getWorkflowGoalFile(workspaceRoot, currentSlug);
  if (!fs.existsSync(goalPath)) return null;
  const raw = readJsonFile<{ text?: string; status?: string } | null>(goalPath, null);
  if (!raw || !raw.text || raw.status !== 'active') return null;
  return { currentSlug, currentGoalStatus: raw.status, currentGoalText: raw.text };
}

/**
 * Path (relative to workspace root) the LLM should `write_file` to for a
 * given artifact. We return a workspace-relative path because that's the
 * unit `write_file` expects.
 */
export function artifactRelativePath(workspaceRoot: string, slug: string, artifact: string): string {
  // Normalize the base to its real path so we don't return a `../../private/...` style
  // relative path on macOS, where /var → /private/var via realpath.
  const normalizedRoot = fs.realpathSync(workspaceRoot);
  const abs = path.join(getWorkflowDir(workspaceRoot, slug), artifact);
  return path.relative(normalizedRoot, abs);
}

export function readArtifact(workspaceRoot: string, slug: string, artifact: string): string | undefined {
  const dir = getWorkflowDir(workspaceRoot, slug);
  const filePath = path.join(dir, artifact);
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}
