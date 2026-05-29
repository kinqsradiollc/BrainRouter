/**
 * BRAIN-P1 (0.4.1) — shared brain-agent status builder.
 *
 * Joins the static registry against the per-kind `memory_jobs` rollup to
 * produce `BrainAgentStatus[]`. Used by both the `memory_agent_status`
 * MCP tool and the `GET /api/brain/agents` dashboard route so they can't
 * drift.
 */

import type { BrainAgentStatus, IMemoryStore } from "@kinqs/brainrouter-types";
import { listBrainAgents } from "./registry.js";

export function buildBrainAgentStatuses(store: IMemoryStore, agentId?: string): BrainAgentStatus[] {
  const byKind = new Map(store.getMemoryJobKindAggregates().map((a) => [a.kind, a]));
  return listBrainAgents()
    .filter((a) => !agentId || a.id === agentId)
    .map((agent) => {
      const agg = byKind.get(agent.id);
      return {
        id: agent.id,
        description: agent.description,
        modelClass: agent.modelClass,
        lastJobStatus: agg?.lastStatus ?? "idle",
        lastJobCompletedAt: agg?.lastCompletedAt ?? null,
        successRate24h: agg?.successRate24h ?? null,
        pendingJobs: agg?.pendingJobs ?? 0,
      };
    });
}
