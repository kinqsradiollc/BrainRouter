/**
 * ADR-041 A41-15 (W3) — external-agent subagent provider.
 *
 * A subagent is normally a fresh in-process {@link Agent} (`spawnWorkerThread`).
 * This backs a worker whose ROLE names a declared external agent
 * (`cli.agents.hosted[].name`) with that external CLI instead — over the SAME
 * `SubprocessPort` seam and the SAME worker-store lifecycle (create → run in the
 * background → summary / status / completion). Selection lives in the default
 * port: a role with no hosted match falls straight through to `spawnWorkerThread`,
 * so the common case is byte-for-byte unchanged.
 *
 * The external run is registered on the interrupt cascade (WS6) via an adapter
 * whose `requestInterrupt` disposes the CLI process, so a parent Stop tears the
 * external worker down too — it does not become an orphan.
 */
import { spawnWorkerThread, type SpawnWorkerInput } from '../../orchestration/agents/workerTools.js';
import type { SubprocessPort } from './subprocessPort.js';
import type { McpClientPool } from '../../mcp/mcpPool.js';
import type { LLMConfig } from '../../config/config.js';
import { getCliKnobs } from '../../config/config.js';
import {
  createWorker,
  updateWorkerMeta,
  writeWorkerSummary,
  appendWorkerTranscript,
  readWorkerMeta,
  type WorkerMeta,
} from '../../worker/workerStore.js';
import { createHostedCliRuntime } from '../../runtime/backends/hostedCli.js';
import { enqueueCompletion } from '../../session/completion/completionInbox.js';
import { registerInterruptibleAgent, unregisterInterruptibleAgent } from '../../orchestration/tools/registry.js';

const ts = (): string => new Date().toISOString();

/** The slice of a runtime the external worker drives — a one-shot run of the goal. */
export interface ExternalWorkerRuntime {
  start(spec: { workspaceRoot: string; launchCwd: string; sessionKey: string; role: string }): Promise<void>;
  exec(turn: { prompt: string }): Promise<{ output: string }>;
  dispose(): Promise<void>;
}

/** True when `role` names a declared external (hosted-CLI) agent. */
export function hostedAgentExistsForRole(role: string): boolean {
  try {
    return getCliKnobs().agents.hosted.some((agent) => agent.name === role);
  } catch {
    return false;
  }
}

/**
 * Spawn a worker backed by the external CLI declared for `input.role`. Mirrors
 * `spawnWorkerThread`'s contract exactly: returns the {@link WorkerMeta} now and
 * runs the external CLI in the background, writing transcript / summary / status
 * to the worker store as it completes or fails. `createRuntime` is injectable for
 * tests; production builds the hosted-CLI runtime for the role.
 */
export function spawnExternalCliWorker(
  input: SpawnWorkerInput,
  createRuntime: (role: string) => ExternalWorkerRuntime = (role) => createHostedCliRuntime({ name: role }),
): WorkerMeta {
  const worker = createWorker(input.workspaceRoot, {
    role: input.role,
    goal: input.goal,
    ownership: input.ownership ?? null,
    depth: input.spawnerDepth,
    parentSessionKey: input.parentSessionKey,
    pid: process.pid,
  });
  appendWorkerTranscript(input.workspaceRoot, worker.id, {
    ts: ts(), role: 'system', event: 'spawn', goal: input.goal, external: input.role,
  });

  const runtime = createRuntime(input.role);
  // WS6 — a parent Stop must tear the external process down too, so register an
  // interrupt adapter that disposes the runtime. Dropped in the finally below.
  registerInterruptibleAgent(worker.id, { requestInterrupt: () => void runtime.dispose().catch(() => {}) }, input.parentSessionKey);

  void (async () => {
    try {
      await runtime.start({
        workspaceRoot: input.workspaceRoot,
        launchCwd: input.launchCwd,
        sessionKey: `${input.parentSessionKey}:worker:${worker.id}`,
        role: input.role,
      });
      const { output } = await runtime.exec({ prompt: input.prompt ?? input.goal });
      appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'assistant', content: output });
      writeWorkerSummary(input.workspaceRoot, worker.id, output);
      // Don't clobber a manual /workers close that landed mid-run.
      if (readWorkerMeta(input.workspaceRoot, worker.id)?.status === 'running') {
        updateWorkerMeta(input.workspaceRoot, worker.id, { status: 'completed' });
        enqueueCompletion(input.parentSessionKey, {
          kind: 'worker', id: worker.id, status: 'completed', label: input.role, summary: output, completedAt: ts(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendWorkerTranscript(input.workspaceRoot, worker.id, { ts: ts(), role: 'system', event: 'error', error: message });
      if (readWorkerMeta(input.workspaceRoot, worker.id)?.status === 'running') {
        updateWorkerMeta(input.workspaceRoot, worker.id, { status: 'failed' });
        enqueueCompletion(input.parentSessionKey, {
          kind: 'worker', id: worker.id, status: 'failed', label: input.role,
          summary: `external agent "${input.role}" failed: ${message}`, completedAt: ts(),
        });
      }
    } finally {
      unregisterInterruptibleAgent(worker.id);
      await runtime.dispose().catch(() => {});
    }
  })();

  return worker;
}

/**
 * The default {@link SubprocessPort}: route to the external CLI when the worker's
 * role names a declared hosted agent, else spawn in-process. With no hosted agents
 * configured (the common case) this is exactly `spawnWorkerThread`, byte-for-byte.
 */
export const defaultSubprocessPort: SubprocessPort = {
  spawnWorker(mcpClient: McpClientPool, llmConfig: LLMConfig, input: SpawnWorkerInput): WorkerMeta {
    if (hostedAgentExistsForRole(input.role)) return spawnExternalCliWorker(input);
    return spawnWorkerThread(mcpClient, llmConfig, input);
  },
};
