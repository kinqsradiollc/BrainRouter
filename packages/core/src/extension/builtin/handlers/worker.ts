// ADR-041 D8 Phase 6 — read_worker_summary (read-only, workspaceRoot only; no new
// host field). readWorkerSummary stays imported in runtime.ts (another worker
// tool still calls it), so it is re-imported here from the same source — no dead
// export. Body verbatim (this.workspaceRoot -> ctx.host.workspaceRoot).

import { readWorkerMeta, readWorkerSummary, closeWorker } from '../../../worker/workerStore.js';
import { waitWorker } from '../../../orchestration/agents/workerTools.js';
import { acknowledgeCompletions } from '../../../session/completion/completionInbox.js';
import type { BuiltinToolHandler } from './registry.js';

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
};