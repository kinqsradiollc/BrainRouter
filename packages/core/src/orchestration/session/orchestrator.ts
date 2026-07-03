import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getStateDir, getStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import { resolveRole, type AccessMode } from '../registry/roles.js';
import type { Tier } from '../registry/agentRegistry.js';

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
  /** MAS-READMANIFEST (B2) — files this child read, forwarded so a downstream
   *  phase reads deltas instead of re-mapping the tree cold. */
  filesRead?: string[];
  /** Agent tier from the definition (reasoning | worker). Undefined for legacy records. */
  tier?: Tier;
  /** Nesting depth in the spawn chain; 0 = direct child of the chat root. */
  depth?: number;
  /**
   * LLM usage attributable to this child (filled when the child completes).
   * MAS-P4-T3 adds `offloadedChars` (output chars kept out of the parent's
   * context via working-memory offload) and `wallClockMs` (spawn→complete).
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    calls: number;
    turns: number;
    offloadedChars?: number;
    wallClockMs?: number;
  };
  /**
   * MAS-P2-M3 — typed snapshot of the parent's runtime state at the
   * moment of spawn. Persisted so `/agents show <id>` can render it
   * post-hoc; the child also receives a copy as its first transcript
   * entry. See `orchestration/parentContext.ts`.
   */
  parentContext?: import('../delegation/parentContext.js').ParentExecutionContextSnapshot;
  /** MAS-P4-T4 — follow-up roles auto-chained after this worker (e.g. ['reviewer','verifier']). */
  autoChainFollowups?: string[];
  /** 0.4.x-1 — true when spawned with an operator overlay (a bespoke one-off agent). */
  synthetic?: boolean;
  /**
   * CODEX-WORKTREE-ISOLATION — filesystem root used by the child when it differs
   * from the parent's workspace root. Parent session bookkeeping remains in the
   * parent workspace; transcript reads use this root when present.
   */
  childWorkspaceRoot?: string;
  childLaunchCwd?: string;
  childWorkspaceIsolation?: {
    kind: 'git-worktree';
    sourceRoot: string;
    worktreeRoot: string;
  };
  childWorkspaceNotice?: string;
  /** CODEX-WORKTREE-CLEANUP — capped diff of the child's isolated-worktree changes, captured at teardown. */
  worktreeDiff?: string;
  /** CODEX-WORKTREE-CLEANUP — number of files the child changed in its worktree. */
  worktreeChangedFiles?: number;
  /** CODEX-WORKTREE-MERGEBACK — path to the full (uncapped) recovery patch of the child's worktree changes. */
  worktreePatchPath?: string;
  /** CODEX-WORKTREE-MERGEBACK — true when those changes were applied back onto the parent working tree. */
  worktreeApplied?: boolean;
  /** CODEX-WORKTREE-MERGEBACK — why merge-back was skipped/failed; the patch remains at worktreePatchPath for manual `git apply`. */
  worktreeApplyError?: string;
}

interface SessionsFile {
  sessions: ChildSessionRecord[];
}

const EMPTY: SessionsFile = { sessions: [] };

function readFile(workspaceRoot: string): SessionsFile {
  return readJsonFile<SessionsFile>(getStateFile(workspaceRoot, 'sessions.json'), EMPTY);
}

function writeFile(workspaceRoot: string, data: SessionsFile): void {
  writeJsonFile(getStateFile(workspaceRoot, 'sessions.json'), data);
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
  tier?: Tier;
  depth?: number;
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
    tier: input.tier,
    depth: input.depth,
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

/** CODEX-WORKTREE-MERGEBACK (A3) — recovery-patch retention window. */
const WORKTREE_PATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * CODEX-WORKTREE-MERGEBACK (A3) — prune isolated-child recovery patches older
 * than the retention window. They're written under
 * `<cliStateDir>/worktree-patches/<childId>.patch` on every isolated-child
 * teardown; without GC they accumulate forever (the worktree-DIR reconcile only
 * cleans `$TMPDIR`). fs-only + best-effort; returns how many it removed.
 */
export function pruneWorktreePatches(workspaceRoot: string, maxAgeMs: number = WORKTREE_PATCH_RETENTION_MS): number {
  let removed = 0;
  try {
    const dir = path.join(getStateDir(workspaceRoot), 'worktree-patches');
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.patch')) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.rmSync(full, { force: true }); removed++; }
      } catch { /* skip this entry */ }
    }
  } catch { /* best-effort */ }
  return removed;
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
  // CODEX-WORKTREE-MERGEBACK (A3) — opportunistic GC of stale recovery patches;
  // cheap (fs-only) so it's fine to run on every reconcile (startup, /agents, /ps).
  pruneWorktreePatches(workspaceRoot);
  return changed;
}

export function formatSessionSummary(s: ChildSessionRecord): string {
  const started = new Date(s.startedAt).getTime();
  const ended = s.completedAt ? new Date(s.completedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.round((ended - started) / 1000));
  const label = s.label ? ` "${s.label}"` : '';
  return `${s.id} [${s.status}] ${s.role}${label} (${elapsedSec}s)`;
}
