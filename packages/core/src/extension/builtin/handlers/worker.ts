// ADR-041 D8 Phase 6 — read_worker_summary (read-only, workspaceRoot only; no new
// host field). readWorkerSummary stays imported in runtime.ts (another worker
// tool still calls it), so it is re-imported here from the same source — no dead
// export. Body verbatim (this.workspaceRoot -> ctx.host.workspaceRoot).

import { readWorkerMeta, readWorkerSummary, closeWorker, canSpawnWorker } from '../../../worker/workerStore.js';
import { waitWorker } from '../../../orchestration/agents/workerTools.js';
import { acknowledgeCompletions } from '../../../session/completion/completionInbox.js';
import { defaultSubprocessPort } from '../../../agent/subprocess/externalCliSubprocess.js';
import type { BuiltinToolHandler } from './registry.js';

// ADR-041 D3 + A41-15 — the default subprocess port. For an ordinary role this is
// `spawnWorkerThread` byte-for-byte; when the role names a declared external agent
// (`cli.agents.hosted`) it spawns via that external CLI instead (A41-15). An
// execution world (D10) can still inject `host.subprocessPort` to spawn elsewhere.
// Referenced lazily at the call site (not aliased at module load) to avoid a
// circular-import temporal dead zone through the hosted-CLI runtime.

export const workerHandlers: Record<string, BuiltinToolHandler> = {
  read_worker_summary: async ({ args, host }) => {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('read_worker_summary requires an id.');
    const meta = readWorkerMeta(host.workspaceRoot, id);
    if (!meta) return `No worker "${id}".`;
    return readWorkerSummary(host.workspaceRoot, id) ?? `Worker ${id} (${meta.status}) has no summary yet.`;
  },

  wait_worker: async ({ args, host }) => {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('wait_worker requires an id.');
    const meta = await waitWorker(host.workspaceRoot, id, typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined);
    if (!meta) return JSON.stringify({ id, found: false });
    // Terminal -> delivered in-turn; drop any pending next-turn feedback.
    // A timeout leaves status 'running', so its completion still reports later.
    if (meta.status !== 'running') acknowledgeCompletions(host.sessionKey, [id]);
    return JSON.stringify({ id, status: meta.status, summary: readWorkerSummary(host.workspaceRoot, id) ?? null });
  },

  close_worker: async ({ args, host }) => {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('close_worker requires an id.');
    const meta = closeWorker(host.workspaceRoot, id);
    return JSON.stringify({ id, status: meta?.status ?? 'unknown', closed: !!meta });
  },

  spawn_worker_thread: async ({ args, host }) => {
        if (!canSpawnWorker(host.agentDepth)) {
          throw new Error('Workers cannot spawn workers (MAX_WORKER_DEPTH=1).');
        }
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('spawn_worker_thread requires a goal.');
        // ADR-041 D3 — spawn via the injected subprocess port (default wraps
        // spawnWorkerThread; an execution world can spawn in a container/remote).
        const worker = (host.subprocessPort ?? defaultSubprocessPort).spawnWorker(host.mcpClient, host.llmConfig, {
          workspaceRoot: host.workspaceRoot,
          launchCwd: host.launchCwd,
          role: String(args.role ?? 'worker'),
          goal,
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          ownership: typeof args.ownership === 'string' ? args.ownership : (host.ownership ?? null),
          parentSessionKey: host.sessionKey,
          parentAccessMode: host.accessMode,
          spawnerDepth: host.agentDepth,
          effortOverride: host.effortOverride,
          ancestorFleet: host.forceFleetSandbox, // HONK-H0 — cascade fleet lockdown
        });
        return JSON.stringify({ id: worker.id, status: worker.status, goal: worker.goal });
  },
};
