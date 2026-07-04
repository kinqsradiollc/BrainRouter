/**
 * MC-A1 — minimal durable runtime-state store.
 *
 * Each runtime instance gets one small JSON record so its lifecycle survives
 * the owning process: the `process` backend's pause() means "park the durable
 * record" (there is no live process/FS state to freeze in-process), and a
 * future boot reconcile can list parked instances and offer resume. State
 * lives under the existing per-workspace CLI state root:
 *
 *   <brainrouter-home>/workspaces/<encoded>/cli/runtime/instances/<id>.json
 *
 * Same file-backed shape + tolerance conventions as `worker/workerStore.ts`
 * (read errors → null, list skips unreadable records).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getStateDir } from '../../storage/store.js';
import type { RuntimeBackendKind, RuntimeStatus } from '../runtimeTypes.js';

/**
 * MC-A2 — where a `worktree`-backed instance lives on disk. Persisted so a
 * PARKED runtime survives its owning process and can be re-attached by path
 * (`attachWorktreeRuntime`), and so a future boot reconcile can find it.
 */
export interface RuntimeWorktreeRef {
  /** Repo root the worktree was carved from (where `git worktree remove` runs). */
  sourceRoot: string;
  /** Absolute path of the provisioned worktree. */
  worktreeRoot: string;
}

/**
 * MC-A3 — where a `container`-backed instance lives. Persisted so a PAUSED
 * container survives its owning process (docker keeps it frozen at ~0 CPU)
 * and can be re-attached by id (`attachContainerRuntime`).
 */
export interface RuntimeContainerRef {
  /** Docker container id `docker run -d` returned. */
  containerId: string;
  /** Image the container was started from (for surfacing/diagnostics). */
  image: string;
}

export interface RuntimeInstanceRecord {
  id: string;
  backend: RuntimeBackendKind;
  workspaceRoot: string;
  sessionKey: string;
  status: RuntimeStatus;
  /** OS pid that owns the live run (stale reconciliation across restarts). */
  pid: number | null;
  /** MC-A2 — set for `worktree` instances once provisioning succeeds. */
  worktree?: RuntimeWorktreeRef | null;
  /** MC-A3 — set for `container` instances once `docker run` succeeds. */
  container?: RuntimeContainerRef | null;
  createdAt: string;
  updatedAt: string;
}

function instancesRoot(workspaceRoot: string): string {
  return path.join(getStateDir(workspaceRoot), 'runtime', 'instances');
}

function recordPath(workspaceRoot: string, id: string): string {
  return path.join(instancesRoot(workspaceRoot), `${id}.json`);
}

export function newRuntimeInstanceId(): string {
  return `rt_${randomUUID().slice(0, 8)}`;
}

export interface CreateRuntimeRecordInput {
  backend: RuntimeBackendKind;
  sessionKey: string;
  status?: RuntimeStatus;
  id?: string;
  pid?: number | null;
  now?: string;
}

export function createRuntimeRecord(workspaceRoot: string, input: CreateRuntimeRecordInput): RuntimeInstanceRecord {
  const now = input.now ?? new Date().toISOString();
  const record: RuntimeInstanceRecord = {
    id: input.id ?? newRuntimeInstanceId(),
    backend: input.backend,
    workspaceRoot,
    sessionKey: input.sessionKey,
    status: input.status ?? 'starting',
    pid: input.pid ?? process.pid,
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(instancesRoot(workspaceRoot), { recursive: true });
  fs.writeFileSync(recordPath(workspaceRoot, record.id), JSON.stringify(record, null, 2) + '\n', 'utf-8');
  return record;
}

export function readRuntimeRecord(workspaceRoot: string, id: string): RuntimeInstanceRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(workspaceRoot, id), 'utf-8')) as RuntimeInstanceRecord;
  } catch {
    return null;
  }
}

export function updateRuntimeRecord(
  workspaceRoot: string,
  id: string,
  patch: Partial<Omit<RuntimeInstanceRecord, 'id' | 'createdAt' | 'workspaceRoot'>>,
  now = new Date().toISOString(),
): RuntimeInstanceRecord | null {
  const current = readRuntimeRecord(workspaceRoot, id);
  if (!current) return null;
  const next: RuntimeInstanceRecord = {
    ...current,
    ...patch,
    id: current.id,
    workspaceRoot: current.workspaceRoot,
    createdAt: current.createdAt,
    updatedAt: now,
  };
  fs.writeFileSync(recordPath(workspaceRoot, id), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return next;
}

export function listRuntimeRecords(workspaceRoot: string): RuntimeInstanceRecord[] {
  const root = instancesRoot(workspaceRoot);
  if (!fs.existsSync(root)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => readRuntimeRecord(workspaceRoot, name.slice(0, -'.json'.length)))
    .filter((r): r is RuntimeInstanceRecord => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function removeRuntimeRecord(workspaceRoot: string, id: string): void {
  fs.rmSync(recordPath(workspaceRoot, id), { force: true });
}
