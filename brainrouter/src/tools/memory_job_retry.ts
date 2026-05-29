import { z } from "zod";
import { memoryEngine } from "../memory/engine.js";
import { retryAgentJob } from "../memory/scheduler/jobs.js";

/**
 * BRAIN-P1-T4 (0.4.1) — `memory_job_retry` (BRAIN-DESIGN-T3).
 *
 * Re-arms a failed or cancelled job: resets `attempts` to 0 and
 * `status` to `pending` with `runAfter = now`. No-op for jobs in
 * `pending`, `running`, or `done` (returns their current status).
 */
export const memoryJobRetryToolSchema = {
  name: "memory_job_retry",
  description:
    "Re-arm a failed or cancelled job. Resets attempts to 0 and status to pending with runAfter = now. No-op for jobs in pending, running, or done.",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Optional; resolved from request context when absent." },
      jobId: { type: "string" },
    },
    required: ["jobId"],
  },
} as const;

export async function handleMemoryJobRetry(args: any, _options?: { defaultUserId?: string }) {
  const params = z.object({ userId: z.string().optional(), jobId: z.string() }).parse(args ?? {});

  try {
    const result = retryAgentJob(memoryEngine.store, params.jobId);
    if (!result) {
      return { isError: true, content: [{ type: "text", text: `No such job: ${params.jobId}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ status: result.status }, null, 2) }] };
  } catch (err: any) {
    return { isError: true, content: [{ type: "text", text: `memory_job_retry failed: ${err.message}` }] };
  }
}
