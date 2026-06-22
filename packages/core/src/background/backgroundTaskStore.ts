/**
 * DURABLE BACKGROUND TASKS (0.4.15 workflow gaps) — a file-backed, linkable
 * record of long-running background work a session launches: a plan revision
 * (requested changes), a code review, a verification run, an attachment job, a
 * delegated workflow/agent. Distinct from `runtime/backgroundTasks.ts`
 * (`collectRunningTasks`), which reflects only the *live in-process* fleet:
 * these records survive workspace/session switches, app refresh, and host
 * reload, so a task and its transcript stay inspectable after it finishes.
 *
 * Persisted WORKSPACE-scoped at
 *   ~/.brainrouter/workspaces/<encoded>/cli/backgroundTasks.json
 * (one file per workspace, each record carrying its `sessionKey`), so the UI
 * can show one session's tasks, the workspace's tasks, or a global active-task
 * indicator from the same source. Pure functions of (workspaceRoot, …) so they
 * are testable without a REPL. BrainRouter memory stays the source of truth for
 * reusable decisions — the caller captures a memory note and links its id back
 * via `linkBackgroundTaskMemory`.
 */
import { randomUUID } from 'node:crypto';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import {
  isActiveBackgroundTask,
  type BackgroundTaskKind,
  type BackgroundTaskProgress,
  type BackgroundTaskRecord,
  type BackgroundTaskStatus,
  type BackgroundTaskTranscriptRef,
} from '@kinqs/brainrouter-types';

/**
 * Stored shape = the durable contract plus an internal `pid` (the process that
 * owns the in-flight work). `pid` is a runtime tag used only by the boot
 * reconcile to flip orphaned tasks; it is not part of the public contract.
 */
type StoredTask = BackgroundTaskRecord & { pid?: number };

interface TaskFile {
  tasks: StoredTask[];
}

const FILE_NAME = 'backgroundTasks.json';
/** Keep at most this many terminal tasks per workspace (newest kept). */
const TERMINAL_CAP = 200;

function file(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, FILE_NAME);
}

// A FRESH default literal per read — never a shared constant, since callers
// build new arrays off `.tasks` (see planHistoryStore for the same reasoning).
function readFile(workspaceRoot: string): TaskFile {
  return readJsonFile<TaskFile>(file(workspaceRoot), { tasks: [] });
}

function writeFile(workspaceRoot: string, data: TaskFile): void {
  writeJsonFile(file(workspaceRoot), data);
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateBackgroundTaskInput {
  kind: BackgroundTaskKind;
  title: string;
  sessionKey: string;
  status?: BackgroundTaskStatus;
  requirementId?: string;
  planId?: string;
  artifactId?: string;
  attachmentId?: string;
  transcript?: BackgroundTaskTranscriptRef;
  sourceEventId?: string;
}

/**
 * Append a new background task (default status `queued`). Returns the stored
 * record. Generates a `btask_<8hex>` id, stamps timestamps, and tags the
 * owning pid so a host restart can reconcile it.
 */
export function createBackgroundTask(
  workspaceRoot: string,
  input: CreateBackgroundTaskInput,
): BackgroundTaskRecord {
  const data = readFile(workspaceRoot);
  const at = nowIso();
  const status = input.status ?? 'queued';
  const record: StoredTask = {
    id: `btask_${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    status,
    title: input.title,
    workspaceRoot,
    sessionKey: input.sessionKey,
    progress: [],
    linkedMemoryIds: [],
    createdAt: at,
    updatedAt: at,
    pid: process.pid,
  };
  if (status === 'running') record.startedAt = at;
  if (input.requirementId) record.requirementId = input.requirementId;
  if (input.planId) record.planId = input.planId;
  if (input.artifactId) record.artifactId = input.artifactId;
  if (input.attachmentId) record.attachmentId = input.attachmentId;
  if (input.transcript) record.transcript = input.transcript;
  if (input.sourceEventId) record.sourceEventId = input.sourceEventId;
  data.tasks.push(record);
  writeFile(workspaceRoot, prune(data));
  return record;
}

export function getBackgroundTask(workspaceRoot: string, id: string): BackgroundTaskRecord | undefined {
  return readFile(workspaceRoot).tasks.find((t) => t.id === id);
}

export interface BackgroundTaskFilter {
  sessionKey?: string;
  kind?: BackgroundTaskKind;
  requirementId?: string;
  /** `active` = queued|running; `all` = everything; otherwise an exact status. */
  status?: 'active' | 'all' | BackgroundTaskStatus;
}

/** Tasks matching the filter, NEWEST-FIRST (by createdAt desc). */
export function listBackgroundTasks(
  workspaceRoot: string,
  filter: BackgroundTaskFilter = {},
): BackgroundTaskRecord[] {
  const { sessionKey, kind, requirementId, status = 'all' } = filter;
  return readFile(workspaceRoot)
    .tasks.map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (sessionKey !== undefined && t.sessionKey !== sessionKey) return false;
      if (kind !== undefined && t.kind !== kind) return false;
      if (requirementId !== undefined && t.requirementId !== requirementId) return false;
      if (status === 'active') return isActiveBackgroundTask(t.status);
      if (status === 'all') return true;
      return t.status === status;
    })
    // Newest-first by createdAt; tie-break on insertion order (tasks are pushed
    // in creation order, so a later index is newer) so same-millisecond creates
    // are still deterministically ordered.
    .sort((a, b) => b.t.createdAt.localeCompare(a.t.createdAt) || b.i - a.i)
    .map(({ t }) => t);
}

/** Count of active (queued|running) tasks in a workspace — drives the sidebar dot. */
export function countActiveBackgroundTasks(workspaceRoot: string, sessionKey?: string): number {
  return listBackgroundTasks(workspaceRoot, { sessionKey, status: 'active' }).length;
}

export interface BackgroundTaskPatch {
  status?: BackgroundTaskStatus;
  title?: string;
  error?: string;
  result?: Record<string, unknown>;
  transcript?: BackgroundTaskTranscriptRef;
  requirementId?: string;
  planId?: string;
  artifactId?: string;
  attachmentId?: string;
  sourceEventId?: string;
}

/**
 * Patch a task's mutable fields. Auto-stamps `updatedAt`; sets `startedAt` the
 * first time it enters `running` and `completedAt` when it reaches a terminal
 * status. Returns the updated record, or undefined when the id is unknown.
 */
export function updateBackgroundTask(
  workspaceRoot: string,
  id: string,
  patch: BackgroundTaskPatch,
): BackgroundTaskRecord | undefined {
  const data = readFile(workspaceRoot);
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return undefined;
  const at = nowIso();
  if (patch.status !== undefined) {
    if (patch.status === 'running' && !t.startedAt) t.startedAt = at;
    if (!isActiveBackgroundTask(patch.status)) t.completedAt = at;
    else t.completedAt = undefined;
    t.status = patch.status;
  }
  if (patch.title !== undefined) t.title = patch.title;
  if (patch.error !== undefined) t.error = patch.error;
  if (patch.result !== undefined) t.result = patch.result;
  if (patch.transcript !== undefined) t.transcript = patch.transcript;
  if (patch.requirementId !== undefined) t.requirementId = patch.requirementId;
  if (patch.planId !== undefined) t.planId = patch.planId;
  if (patch.artifactId !== undefined) t.artifactId = patch.artifactId;
  if (patch.attachmentId !== undefined) t.attachmentId = patch.attachmentId;
  if (patch.sourceEventId !== undefined) t.sourceEventId = patch.sourceEventId;
  t.updatedAt = at;
  writeFile(workspaceRoot, data);
  return t;
}

/** Push a phase checkpoint onto a running task (stamps `at` + bumps updatedAt). */
export function appendTaskProgress(
  workspaceRoot: string,
  id: string,
  progress: Omit<BackgroundTaskProgress, 'at'> & { at?: string },
): BackgroundTaskRecord | undefined {
  const data = readFile(workspaceRoot);
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return undefined;
  const at = progress.at ?? nowIso();
  const entry: BackgroundTaskProgress = { phase: progress.phase, at };
  if (progress.note !== undefined) entry.note = progress.note;
  if (progress.pct !== undefined) entry.pct = progress.pct;
  t.progress.push(entry);
  t.updatedAt = at;
  writeFile(workspaceRoot, data);
  return t;
}

/** Link a memory id into a task's `linkedMemoryIds` (de-duplicated). */
export function linkBackgroundTaskMemory(
  workspaceRoot: string,
  id: string,
  memoryId: string,
): BackgroundTaskRecord | undefined {
  if (!memoryId) return getBackgroundTask(workspaceRoot, id);
  const data = readFile(workspaceRoot);
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return undefined;
  if (!t.linkedMemoryIds.includes(memoryId)) {
    t.linkedMemoryIds.push(memoryId);
    t.updatedAt = nowIso();
    writeFile(workspaceRoot, data);
  }
  return t;
}

/** The current phase name (last progress entry), for a compact event view. */
export function currentPhase(task: BackgroundTaskRecord): string | undefined {
  return task.progress.length ? task.progress[task.progress.length - 1].phase : undefined;
}

/**
 * Boot reconcile: a host owns its background work IN-PROCESS, so a restart
 * orphans any task left `queued`/`running`. Flip every active task whose owning
 * pid is no longer alive to `failed`. Returns how many were reconciled.
 * Mirrors `reconcileStaleBackgroundTasks` for the live fleet; the `isAlive`
 * probe is injectable for tests.
 */
export function reconcileBackgroundTasks(
  workspaceRoot: string,
  isAlive: (pid: number | null | undefined) => boolean,
): number {
  const data = readFile(workspaceRoot);
  let n = 0;
  const at = nowIso();
  for (const t of data.tasks) {
    if (isActiveBackgroundTask(t.status) && !isAlive(t.pid)) {
      t.status = 'failed';
      t.error = t.error ?? 'Interrupted — the host process exited before the task finished.';
      t.completedAt = at;
      t.updatedAt = at;
      n++;
    }
  }
  if (n > 0) writeFile(workspaceRoot, data);
  return n;
}

/** Drop the oldest terminal tasks beyond {@link TERMINAL_CAP}. Active tasks are kept. */
function prune(data: TaskFile): TaskFile {
  const terminal = data.tasks.filter((t) => !isActiveBackgroundTask(t.status));
  if (terminal.length <= TERMINAL_CAP) return data;
  // Sort terminal newest-first, keep the cap, then re-assemble preserving the
  // active tasks (order within the file is not load-bearing — reads sort).
  const keepTerminal = new Set(
    [...terminal].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, TERMINAL_CAP).map((t) => t.id),
  );
  data.tasks = data.tasks.filter((t) => isActiveBackgroundTask(t.status) || keepTerminal.has(t.id));
  return data;
}
