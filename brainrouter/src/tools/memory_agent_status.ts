import { z } from "zod";
import type { BrainAgentStatus } from "@kinqs/brainrouter-types";
import { memoryEngine } from "../memory/engine.js";
import { listBrainAgents, findBrainAgentById } from "../memory/agents/registry.js";

/**
 * BRAIN-P1-T4 (0.4.1) — `memory_agent_status` (BRAIN-DESIGN-T3).
 *
 * Read-only. Joins the static brain-agent registry against the
 * per-kind `memory_jobs` rollup so dashboards / `/brain agents` can
 * render each agent's last-run status, 24h success rate, and pending
 * count. Safe to poll on a ~10s interval.
 */
export const memoryAgentStatusToolSchema = {
  name: "memory_agent_status",
  description:
    "List brain agents with their last-run status, success rate, and pending-job counts. Read-only; safe for dashboards to poll on a 10s interval.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Optional; resolved from request context when absent." },
      agentId: { type: "string", description: "Optional — when set, return only this agent." },
    },
  },
} as const;

export async function handleMemoryAgentStatus(args: any, _options?: { defaultUserId?: string }) {
  const params = z
    .object({ userId: z.string().optional(), agentId: z.string().optional() })
    .parse(args ?? {});

  try {
    if (params.agentId && !findBrainAgentById(params.agentId)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown brain agent: ${params.agentId}` }],
      };
    }

    const aggregates = memoryEngine.store.getMemoryJobKindAggregates();
    const byKind = new Map(aggregates.map((a) => [a.kind, a]));

    const agents: BrainAgentStatus[] = listBrainAgents()
      .filter((a) => !params.agentId || a.id === params.agentId)
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

    return { content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }] };
  } catch (err: any) {
    return { isError: true, content: [{ type: "text", text: `memory_agent_status failed: ${err.message}` }] };
  }
}
