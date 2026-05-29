import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";
import { enqueueAgentJob, UnknownBrainAgentError } from "../memory/scheduler/jobs.js";

/**
 * BRAIN-P1-T4 (0.4.1) — `memory_agent_run` (BRAIN-DESIGN-T3).
 *
 * Enqueues a brain-agent run and returns the job id immediately;
 * status is observed via `memory_agent_status`. Idempotent per the
 * agent's `idempotencyKey` — re-enqueueing while a job is
 * pending/running returns the existing jobId.
 */
export const memoryAgentRunToolSchema = {
  name: "memory_agent_run",
  description:
    "Enqueue a brain-agent run with the provided input. Returns the job id immediately; status is observed via memory_agent_status. Idempotent per the agent's idempotencyKey — re-enqueueing while a job is pending/running returns the existing jobId.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Optional; resolved from request context when absent." },
      agentId: { type: "string" },
      input: { type: "object" },
      priority: { type: "number", description: "Override default 50; higher runs sooner." },
    },
    required: ["agentId", "input"],
  },
} as const;

export async function handleMemoryAgentRun(args: any, options?: { defaultUserId?: string }) {
  const params = z
    .object({
      userId: z.string().optional(),
      agentId: z.string(),
      input: z.record(z.unknown()).default({}),
      priority: z.number().optional(),
    })
    .parse(args ?? {});

  const effectiveUserId = params.userId ?? options?.defaultUserId ?? "default";
  // Thread the resolved userId into the job input so per-user agents
  // (focus/identity distillers) route correctly without a table column.
  const input = { userId: effectiveUserId, ...params.input };

  try {
    const { job, deduped } = enqueueAgentJob(memoryEngine.store, params.agentId, input, {
      priority: params.priority,
    });
    return {
      content: [
        { type: "text", text: JSON.stringify({ jobId: job.id, status: job.status, deduped }, null, 2) },
      ],
    };
  } catch (err: any) {
    if (err instanceof UnknownBrainAgentError) {
      return { isError: true, content: [{ type: "text", text: `Unknown brain agent: ${err.agentId}` }] };
    }
    return { isError: true, content: [{ type: "text", text: `memory_agent_run failed: ${err.message}` }] };
  }
}
