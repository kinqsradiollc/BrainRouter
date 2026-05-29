/**
 * MAS-P5-T3 (0.4.2) — dedicated worker threads: persistence layer.
 *
 * A worker is a long-running child agent whose state is durable on disk so
 * it survives the parent turn (and, with the federation registry, a CLI
 * restart). State lives under:
 *
 *   <workspace>/.brainrouter/cli/workers/<id>/
 *     meta.json        status + lineage
 *     transcript.jsonl one JSON line per turn/event
 *     goal.json        the worker's own goal
 *     plan.json        the worker's own plan
 *     summary.md       rolling periodic summary (read_worker_summary)
 *
 * Workers cannot spawn workers (`MAX_WORKER_DEPTH = 1`). This module is the
 * file-backed model + the depth guard; the detached execution + attach/
 * detach/wait runtime layers on top of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Workers can't spawn workers — a single level of background depth. */
export const MAX_WORKER_DEPTH = 1;

export type WorkerStatus = 'running' | 'completed' | 'failed' | 'closed';

export interface WorkerMeta {
  id: string;
  status: WorkerStatus;
  role: string;
  goal: string;
  /** Ownership glob the worker's writes are gated to (MAS-P3). */
  ownership: string | null;
  /** Spawn depth (0 = spawned by the chat root). Always < MAX_WORKER_DEPTH. */
  depth: number;
  parentSessionKey: string | null;
  /** OS pid that owns the run, for stale reconciliation across restarts. */
  pid: number | null;
  createdAt: string;
  updatedAt: string;
}

function workersRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'cli', 'workers');
}

export function workerDir(workspaceRoot: string, id: string): string {
  return path.join(workersRoot(workspaceRoot), id);
}

function metaPath(workspaceRoot: string, id: string): string {
  return path.join(workerDir(workspaceRoot, id), 'meta.json');
}

/** Depth guard: a worker at `depth` may spawn a worker only if under the cap. */
export function canSpawnWorker(parentDepth: number): boolean {
  return parentDepth < MAX_WORKER_DEPTH;
}

export interface CreateWorkerInput {
  role: string;
  goal: string;
  ownership?: string | null;
  depth?: number;
  parentSessionKey?: string | null;
  pid?: number | null;
  id?: string;
  now?: string;
}

export function createWorker(workspaceRoot: string, input: CreateWorkerInput): WorkerMeta {
  const id = input.id ?? `wkr_${randomUUID().slice(0, 8)}`;
  const now = input.now ?? new Date().toISOString();
  const meta: WorkerMeta = {
    id,
    status: 'running',
    role: input.role,
    goal: input.goal,
    ownership: input.ownership ?? null,
    depth: input.depth ?? 0,
    parentSessionKey: input.parentSessionKey ?? null,
    pid: input.pid ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const dir = workerDir(workspaceRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(workspaceRoot, id), JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  if (input.goal) {
    fs.writeFileSync(path.join(dir, 'goal.json'), JSON.stringify({ text: input.goal, createdAt: now }, null, 2) + '\n', 'utf-8');
  }
  return meta;
}

export function readWorkerMeta(workspaceRoot: string, id: string): WorkerMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(workspaceRoot, id), 'utf-8')) as WorkerMeta;
  } catch {
    return null;
  }
}

export function updateWorkerMeta(
  workspaceRoot: string,
  id: string,
  patch: Partial<Omit<WorkerMeta, 'id' | 'createdAt'>>,
  now = new Date().toISOString(),
): WorkerMeta | null {
  const current = readWorkerMeta(workspaceRoot, id);
  if (!current) return null;
  const next: WorkerMeta = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: now };
  fs.writeFileSync(metaPath(workspaceRoot, id), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

export function listWorkers(workspaceRoot: string): WorkerMeta[] {
  const root = workersRoot(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readWorkerMeta(workspaceRoot, e.name))
    .filter((m): m is WorkerMeta => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendWorkerTranscript(workspaceRoot: string, id: string, entry: unknown): void {
  const dir = workerDir(workspaceRoot, id);
  if (!fs.existsSync(dir)) return;
  fs.appendFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
}

export function writeWorkerSummary(workspaceRoot: string, id: string, markdown: string): void {
  const dir = workerDir(workspaceRoot, id);
  if (!fs.existsSync(dir)) return;
  fs.writeFileSync(path.join(dir, 'summary.md'), markdown, 'utf-8');
}

export function readWorkerSummary(workspaceRoot: string, id: string): string | null {
  try {
    return fs.readFileSync(path.join(workerDir(workspaceRoot, id), 'summary.md'), 'utf-8');
  } catch {
    return null;
  }
}

/** Mark a worker closed (terminal). Returns the updated meta, or null if unknown. */
export function closeWorker(workspaceRoot: string, id: string): WorkerMeta | null {
  return updateWorkerMeta(workspaceRoot, id, { status: 'closed' });
}
