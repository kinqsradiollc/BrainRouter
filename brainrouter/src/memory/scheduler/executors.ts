/**
 * BRAIN-P1 (0.4.1) — on-demand job executors.
 *
 * The async runner (`runner.ts`) drains queued `memory_jobs` rows that
 * were enqueued via `memory_agent_run` / `/brain run`. To run one it
 * needs a binding from a brain-agent id to the real pipeline function.
 *
 * NOT every agent is on-demand runnable. The extraction-family stages
 * (`cognitive_extractor`, `memory_deduper`, `contradiction_checker`,
 * `graph_extractor`, `focus_shift_judge`) run *inline* during capture
 * (wrapped by `runAsJob`, already observable) and need rich per-turn
 * input that a manual enqueue can't supply. Those have no executor here
 * — the runner cancels a manual run of them with a clear reason instead
 * of hanging.
 *
 * The agents that ARE meaningful to trigger on demand are the per-user
 * synthesis distillers: "re-distill my identity / focus scenes now".
 */

import type { IMemoryStore, LLMRunner } from "@kinqs/brainrouter-types";
import { distillCoreIdentity } from "../pipeline/identity-distiller.js";
import { distillFocusScenes } from "../pipeline/contextual-focus-builder.js";

export interface JobExecContext {
  store: IMemoryStore;
  llmRunner: LLMRunner;
}

/** Runs the agent's work for `input`; returns a compact JSON summary for `output`. */
export type JobExecutor = (input: any, ctx: JobExecContext) => Promise<unknown>;

function userIdOf(input: any): string {
  const u = input?.userId;
  return typeof u === "string" && u ? u : "default";
}

const EXECUTORS: Record<string, JobExecutor> = {
  identity_distiller: async (input, { store, llmRunner }) => {
    const r = await distillCoreIdentity({ userId: userIdOf(input), store, llmRunner });
    return { success: r.success };
  },
  focus_distiller: async (input, { store, llmRunner }) => {
    const r = await distillFocusScenes({ userId: userIdOf(input), store, llmRunner });
    return { sceneNames: r.sceneNames };
  },
};

export function getJobExecutor(agentId: string): JobExecutor | undefined {
  return EXECUTORS[agentId];
}

/** Agent ids the async runner can execute on demand. */
export function onDemandRunnableAgentIds(): string[] {
  return Object.keys(EXECUTORS);
}
