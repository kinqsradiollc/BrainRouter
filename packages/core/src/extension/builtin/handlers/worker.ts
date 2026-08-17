// ADR-041 D8 Phase 6 — read_worker_summary (read-only, workspaceRoot only; no new
// host field). readWorkerSummary stays imported in runtime.ts (another worker
// tool still calls it), so it is re-imported here from the same source — no dead
// export. Body verbatim (this.workspaceRoot -> ctx.host.workspaceRoot).

import { readWorkerMeta, readWorkerSummary } from '../../../worker/workerStore.js';
import type { BuiltinToolHandler } from './registry.js';

export const workerHandlers: Record<string, BuiltinToolHandler> = {
  read_worker_summary: async ({ args, host }) => {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('read_worker_summary requires an id.');
    const meta = readWorkerMeta(host.workspaceRoot, id);
    if (!meta) return `No worker "${id}".`;
    return readWorkerSummary(host.workspaceRoot, id) ?? `Worker ${id} (${meta.status}) has no summary yet.`;
  },
};
