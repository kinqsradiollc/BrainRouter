import { randomUUID } from 'node:crypto';
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import type { AgentAdapterId, HostedAgentStatus } from '../agent/adapters/types.js';

export type FanoutRunStatus = 'launching' | 'running' | 'comparing' | 'promoted' | 'failed' | 'cancelled';

export interface FanoutCandidate {
  id: string;
  adapterId: AgentAdapterId;
  status: HostedAgentStatus;
  worktreeRoot?: string;
  terminalId?: string;
  /** `local` or a workspace-scoped pinned SSH host id. */
  executionHostId?: string;
  /** Base commit proven identical on local and remote before launch. */
  baseOid?: string;
  changedFiles: number;
  diffSummary?: string;
  patchPath?: string;
  score?: number;
  rank?: number;
  review?: { critical: number; major: number; minor: number; note?: string };
  error?: string;
  updatedAt: string;
}

export interface FanoutRun {
  id: string;
  task: string;
  baseRef: string;
  status: FanoutRunStatus;
  workspaceRoot: string;
  executionHostId?: string;
  candidates: FanoutCandidate[];
  winnerId?: string;
  promotion?: { mode: 'merge' | 'pr'; ok: boolean; url?: string; error?: string; at: string };
  createdAt: string;
  updatedAt: string;
}

interface Store { version: 1; runs: FanoutRun[] }
const empty = (): Store => ({ version: 1, runs: [] });
const file = (workspaceRoot: string): string => getStateFile(workspaceRoot, 'fanoutRuns.json');

function read(workspaceRoot: string): Store { return readJsonFile<Store>(file(workspaceRoot), empty()); }
function write(workspaceRoot: string, store: Store): void {
  writeJsonFile(file(workspaceRoot), { ...store, runs: store.runs.slice(-100) });
}
function copy<T>(value: T): T { return structuredClone(value); }

export function createFanoutRun(workspaceRoot: string, input: { task: string; adapterIds: AgentAdapterId[]; baseRef?: string; executionHostId?: string }, now = new Date()): FanoutRun {
  const task = input.task.trim();
  if (!task) throw new Error('Fan-out task is required.');
  if (input.adapterIds.length < 2 || input.adapterIds.length > 8) throw new Error('Fan-out requires 2 to 8 candidates.');
  const at = now.toISOString();
  const runId = `fan_${randomUUID().slice(0, 8)}`;
  const run: FanoutRun = {
    id: runId, task, baseRef: input.baseRef?.trim() || 'HEAD', status: 'launching', workspaceRoot,
    executionHostId: input.executionHostId?.trim() || 'local',
    candidates: input.adapterIds.map((adapterId, index) => ({
      id: `${runId}_c${index + 1}`, adapterId, status: 'starting', changedFiles: 0,
      executionHostId: input.executionHostId?.trim() || 'local', updatedAt: at,
    })),
    createdAt: at, updatedAt: at,
  };
  const store = read(workspaceRoot);
  store.runs.push(run);
  write(workspaceRoot, store);
  return copy(run);
}

export function getFanoutRun(workspaceRoot: string, runId: string): FanoutRun | undefined {
  const run = read(workspaceRoot).runs.find((item) => item.id === runId);
  return run ? copy(run) : undefined;
}

export function listFanoutRuns(workspaceRoot: string): FanoutRun[] {
  return read(workspaceRoot).runs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(copy);
}

export function updateFanoutRun(workspaceRoot: string, runId: string, patch: Partial<Omit<FanoutRun, 'id' | 'workspaceRoot' | 'candidates'>>, now = new Date()): FanoutRun | undefined {
  const store = read(workspaceRoot);
  const run = store.runs.find((item) => item.id === runId);
  if (!run) return undefined;
  Object.assign(run, patch, { updatedAt: now.toISOString() });
  write(workspaceRoot, store);
  return copy(run);
}

export function updateFanoutCandidate(workspaceRoot: string, runId: string, candidateId: string, patch: Partial<Omit<FanoutCandidate, 'id' | 'adapterId'>>, now = new Date()): FanoutRun | undefined {
  const store = read(workspaceRoot);
  const run = store.runs.find((item) => item.id === runId);
  const candidate = run?.candidates.find((item) => item.id === candidateId);
  if (!run || !candidate) return undefined;
  Object.assign(candidate, patch, { updatedAt: now.toISOString() });
  run.updatedAt = candidate.updatedAt;
  write(workspaceRoot, store);
  return copy(run);
}

export function rankFanoutCandidates(candidates: FanoutCandidate[]): FanoutCandidate[] {
  const score = (candidate: FanoutCandidate): number => {
    const status = candidate.status === 'done' ? 30 : candidate.status === 'working' || candidate.status === 'waiting' ? 10 : candidate.status === 'failed' ? -100 : 0;
    const usefulDiff = candidate.changedFiles > 0 ? Math.max(0, 20 - Math.abs(candidate.changedFiles - 8)) : -20;
    const tests = /(?:^|\s)(?:test|spec)s?\//i.test(candidate.diffSummary ?? '') || /\.(?:test|spec)\./i.test(candidate.diffSummary ?? '') ? 12 : 0;
    const review = candidate.review ? candidate.review.critical * -40 + candidate.review.major * -15 + candidate.review.minor * -3 : 0;
    const risk = /\.env|private[_-]?key|credential/i.test(candidate.diffSummary ?? '') ? -50 : 0;
    return status + usefulDiff + tests + review + risk;
  };
  return candidates.map((candidate) => ({ ...candidate, score: score(candidate) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
