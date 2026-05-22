import { randomUUID } from 'node:crypto';
import { getCliStateFile, readJsonFile, writeJsonFile } from '../state/cliState.js';
import { resolveRole, type AccessMode } from './roles.js';

export type ChildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stale' | 'closed';

export interface ChildSessionRecord {
  id: string;
  label?: string;
  role: string;
  access: AccessMode;
  parentSessionKey: string;
  prompt: string;
  status: ChildStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  pid: number;
  finalOutput?: string;
  error?: string;
  /** LLM usage attributable to this child (filled when the child completes). */
  usage?: { promptTokens: number; completionTokens: number; calls: number; turns: number };
}

interface SessionsFile {
  sessions: ChildSessionRecord[];
}

const EMPTY: SessionsFile = { sessions: [] };

function readFile(workspaceRoot: string): SessionsFile {
  return readJsonFile<SessionsFile>(getCliStateFile(workspaceRoot, 'sessions.json'), EMPTY);
}

function writeFile(workspaceRoot: string, data: SessionsFile): void {
  writeJsonFile(getCliStateFile(workspaceRoot, 'sessions.json'), data);
}

export function listSessions(workspaceRoot: string): ChildSessionRecord[] {
  return readFile(workspaceRoot).sessions;
}

export function getSession(workspaceRoot: string, id: string): ChildSessionRecord | undefined {
  return readFile(workspaceRoot).sessions.find((s) => s.id === id);
}

export function createSession(workspaceRoot: string, input: {
  role: string;
  prompt: string;
  parentSessionKey: string;
  access?: AccessMode;
  label?: string;
}): ChildSessionRecord {
  const role = resolveRole(input.role);
  const now = new Date().toISOString();
  const record: ChildSessionRecord = {
    id: `agent-${randomUUID().slice(0, 8)}`,
    role: role.name,
    label: input.label,
    access: input.access ?? role.defaultAccess,
    parentSessionKey: input.parentSessionKey,
    prompt: input.prompt,
    status: 'pending',
    startedAt: now,
    updatedAt: now,
    pid: process.pid,
  };
  const data = readFile(workspaceRoot);
  data.sessions.push(record);
  writeFile(workspaceRoot, data);
  return record;
}

export function updateSession(workspaceRoot: string, id: string, patch: Partial<ChildSessionRecord>): ChildSessionRecord {
  const data = readFile(workspaceRoot);
  const idx = data.sessions.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`No child session with id ${id}.`);
  const merged: ChildSessionRecord = {
    ...data.sessions[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  data.sessions[idx] = merged;
  writeFile(workspaceRoot, data);
  return merged;
}

export function reconcileStale(workspaceRoot: string): number {
  const data = readFile(workspaceRoot);
  let changed = 0;
  for (const s of data.sessions) {
    if ((s.status === 'pending' || s.status === 'running') && s.pid !== process.pid) {
      s.status = 'stale';
      s.updatedAt = new Date().toISOString();
      changed++;
    }
  }
  if (changed > 0) writeFile(workspaceRoot, data);
  return changed;
}

export function formatSessionSummary(s: ChildSessionRecord): string {
  const started = new Date(s.startedAt).getTime();
  const ended = s.completedAt ? new Date(s.completedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.round((ended - started) / 1000));
  const label = s.label ? ` "${s.label}"` : '';
  return `${s.id} [${s.status}] ${s.role}${label} (${elapsedSec}s)`;
}
