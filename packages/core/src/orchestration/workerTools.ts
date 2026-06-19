/**
 * MAS-P5-T3 part 2 (0.4.2) — worker-thread runtime.
 *
 * Runs a worker as a detached, in-process Agent (mirroring `handleSpawn`)
 * that persists its transcript + rolling summary + terminal status to the
 * on-disk worker model (`state/workerStore.ts`) as it goes. The parent's
 * turn does NOT block — the worker promise is tracked in `runningWorkers`
 * so `wait_worker` can await it, and the disk state lets `/workers` observe
 * a worker at any time (even after the parent turn ends).
 *
 * Resumability: a worker dies with its CLI process. On restart its disk
 * state is intact but the promise is gone, so `reconcileStaleWorkers`
 * (workerStore) flips orphaned `running` workers to `failed` rather than
 * pretending to resume mid-turn. Re-spawn with the same goal to continue.
 */

import { Agent } from '../agent/agent.js';
import type { McpClientPool } from '../mcp/mcpPool.js';
import type { LLMConfig } from '../config/config.js';
import { loadOrInitConfig } from '../config/config.js';
import { resolveAgentLlm } from '../provider/agentModels.js';
import type { AccessMode } from './roles.js';
import type { EffortLevel } from '../session/preferencesStore.js';
import {
  createWorker,
  readWorkerMeta,
  updateWorkerMeta,
  appendWorkerTranscript,
  writeWorkerSummary,
  type WorkerMeta,
} from '../worker/workerStore.js';
import { enqueueCompletion } from '../session/completionInbox.js';

/** In-process worker runs, keyed by worker id. */
const runningWorkers = new Map<string, Promise<void>>();

const DEFAULT_WORKER_WAIT_TIMEOUT_MS = 600_000;

export interface SpawnWorkerInput {
  workspaceRoot: string;
  launchCwd: string;
  role: string;
  goal: string;
  /** Task prompt the worker runs; defaults to the goal. */
  prompt?: string;
  ownership?: string | null;
  parentSessionKey: string;
  parentAccessMode?: AccessMode;
  /** The spawning agent's depth (the worker is created at this depth). */
  spawnerDepth: number;
  effortOverride?: EffortLevel;
}

function ts(): string {
  return new Date().toISOString();
}

/**
 * Create + launch a worker detached. Returns its meta immediately; the run
 * continues in the background, writing transcript/summary/status to disk.
 */
export function spawnWorkerThread(
  mcpClient: McpClientPool,
  llmConfig: LLMConfig,
  input: SpawnWorkerInput,
): WorkerMeta {
  const worker = createWorker(input.workspaceRoot, {
    role: input.role,
    goal: input.goal,
    ownership: input.ownership ?? null,
    depth: input.spawnerDepth,
    parentSessionKey: input.parentSessionKey,
    pid: process.pid,
  });

  // 0.4.15 — route the worker to its role's configured provider/model.
  const workerLlm = resolveAgentLlm(loadOrInitConfig(), llmConfig, input.role);
  const childAgent = new Agent(mcpClient, workerLlm, {
    workspaceRoot: input.workspaceRoot,
    launchCwd: input.launchCwd,
    sessionKey: `${input.parentSessionKey}:worker:${worker.id}`,
    accessMode: input.parentAccessMode ?? 'write',
    silent: true,
    enableRecall: true,
    ownership: input.ownership ?? null,
    tier: 'worker',
    agentDepth: input.spawnerDepth + 1,
    effortOverride: input.effortOverride,
  });

  appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'system', event: 'spawn', goal: input.goal });

  const promise = (async () => {
    try {
      const output = await childAgent.runTurn(input.prompt ?? input.goal, {
        onStatusUpdate: () => {},
        onToolStart: (tool: string) =>
          appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'tool', event: 'start', tool }),
        onToolEnd: (tool: string, result: { success?: boolean; summary?: string }) =>
          appendWorkerTranscript(input.workspaceRoot, worker.id, {
            ts: ts(),
            role: 'tool',
            event: 'end',
            tool,
            ok: result?.success ?? true,
            summary: result?.summary,
          }),
      } as any);
      appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'assistant', content: output });
      writeWorkerSummary(input.workspaceRoot, worker.id, output);
      // Don't clobber a manual /workers close that landed mid-run.
      if (readWorkerMeta(input.workspaceRoot, worker.id)?.status === 'running') {
        updateWorkerMeta(input.workspaceRoot, worker.id, { status: 'completed' });
        // COMPLETION-FEEDBACK — report the result back to the spawning agent's
        // next turn (it didn't necessarily `wait_worker`).
        enqueueCompletion(input.parentSessionKey, {
          kind: 'worker', id: worker.id, status: 'completed',
          label: input.role, summary: output, completedAt: ts(),
        });
      }
    } catch (err) {
      // ORCH-FIX (worker analog) — the failure-bookkeeping itself touches disk
      // (transcript append + meta read/write); if THAT throws, it must not
      // reject the detached worker promise. Isolate it in its own try/catch so
      // a worker failure can never escalate into an unhandled rejection.
      try {
        appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'system', event: 'error', error: (err as Error).message });
        if (readWorkerMeta(input.workspaceRoot, worker.id)?.status === 'running') {
          updateWorkerMeta(input.workspaceRoot, worker.id, { status: 'failed' });
          enqueueCompletion(input.parentSessionKey, {
            kind: 'worker', id: worker.id, status: 'failed',
            label: input.role, summary: (err as Error).message, completedAt: ts(),
          });
        }
      } catch (bookkeepingErr: any) {
        console.error(`[BrainRouter] worker ${worker.id} failure-bookkeeping threw (isolated):`, bookkeepingErr?.message ?? bookkeepingErr);
      }
    } finally {
      runningWorkers.delete(worker.id);
    }
  })();

  // ORCH-FIX (worker analog) — store the promise WITH a .catch backstop so a
  // fire-and-forget worker (one nobody `wait_worker`s) can never surface as an
  // unhandled rejection. `waitWorker` adds its own .catch on the race, so this
  // double-guard is harmless; the stored value stays Promise<void>.
  runningWorkers.set(
    worker.id,
    promise.catch((e: any) => {
      console.error(`[BrainRouter] worker ${worker.id} promise rejected (isolated):`, e?.message ?? e);
    }),
  );
  return worker;
}

/** True if the worker is still running in THIS process. */
export function isWorkerRunningHere(id: string): boolean {
  return runningWorkers.has(id);
}

/**
 * Await a worker's completion. By default the wait is bounded; pass
 * timeoutMs <= 0 to wait until a live in-process worker reaches terminal
 * state. A bounded wait timeout only returns the latest meta and never marks
 * the worker failed.
 */
export async function waitWorker(
  workspaceRoot: string,
  id: string,
  timeoutMs: number = DEFAULT_WORKER_WAIT_TIMEOUT_MS,
): Promise<WorkerMeta | null> {
  const p = runningWorkers.get(id);
  if (p) {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      await Promise.race([p.catch(() => {}), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    } else {
      await p.catch(() => {});
    }
  }
  return readWorkerMeta(workspaceRoot, id);
}
