import fs from 'node:fs';
import path from 'node:path';
import { getCliStateDir, getCliStateFile, isPathInside, readJsonFile, writeJsonFile } from './cliState.js';

/**
 * Canonical home for durable workflow artifacts produced by the multi-agent
 * commands (/feature-dev, /spec, /review, /implement-plan).
 *
 * One workflow == one slug == one directory:
 *   <workspace>/.brainrouter/cli/workflows/<slug>/
 *     spec.md         — the agreed specification (what + why + boundaries)
 *     tasks.md        — human-readable task breakdown for execution
 *     walkthrough.md  — post-implementation summary (what was built, where)
 *     meta.json       — { slug, title, kind, createdAt, updatedAt, status }
 *     notes/          — optional supplementary artifacts (explorer reports etc.)
 *
 * Keeping every artifact for a workflow in one folder is the rule the user
 * asked for: "Everything should be 1 place right?" — yes.
 */

const WORKFLOWS_SUBDIR = 'workflows';
const CURRENT_POINTER_FILE = 'current-workflow.json';

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
  const stateDir = getCliStateDir(workspaceRoot);
  const root = path.join(stateDir, WORKFLOWS_SUBDIR);
  if (!isPathInside(stateDir, root)) {
    throw new Error('Workflows root escapes CLI state directory.');
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

export function createWorkflow(
  workspaceRoot: string,
  input: { title: string; kind: WorkflowMeta['kind']; slug?: string },
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
  setCurrentWorkflow(workspaceRoot, slug);
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

export function setCurrentWorkflow(workspaceRoot: string, slug: string): void {
  writeJsonFile(getCliStateFile(workspaceRoot, CURRENT_POINTER_FILE), { slug, at: new Date().toISOString() });
}

export function getCurrentWorkflow(workspaceRoot: string): string | undefined {
  const ptr = readJsonFile<{ slug?: string } | null>(getCliStateFile(workspaceRoot, CURRENT_POINTER_FILE), null);
  return ptr?.slug;
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
