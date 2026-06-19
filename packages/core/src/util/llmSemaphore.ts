/**
 * Process-wide semaphore for CLI-side LLM calls.
 *
 * The CLI fires LLM requests from two places:
 *   1. The user-facing chat in `callOpenAI` (the assistant reply).
 *   2. Each spawned child agent's own chat loop (parallel fan-out from
 *      `spawn_agents` runs all children concurrently).
 *
 * When all of those plus the MCP child's background extraction/contradiction
 * /graph workers hit the same local backend (LM Studio with a single GPU,
 * or any throughput-bounded endpoint), the model thrashes or auto-unloads.
 * Capping concurrency here prevents the CLI process from overwhelming the
 * backend. The MCP child has its own matching semaphore (mcp/.../llm-semaphore.ts)
 * with the same knob, so the two processes coordinate by setting the same
 * `cli.llmMaxConcurrent` budget in `~/.config/brainrouter/config.json`.
 *
 * Knob:
 *   cli.llmMaxConcurrent  (default 4; values < 1 disable the cap)
 *
 * Cap defaults higher on the CLI side than on MCP (4 vs 2) because the
 * user-facing chat is latency-sensitive; we'd rather burst chat calls and
 * queue background extraction.
 */

import { getCliKnobs } from '../config/config.js';

function resolveCap(): number {
  const parsed = getCliKnobs().llmMaxConcurrent;
  if (!Number.isFinite(parsed) || parsed < 1) return Number.POSITIVE_INFINITY;
  return parsed;
}

let cap = resolveCap();
let inFlight = 0;
const waiters: Array<() => void> = [];

export async function acquireLLMSlot(): Promise<() => void> {
  if (!Number.isFinite(cap)) return () => {};
  if (inFlight < cap) {
    inFlight++;
    return makeRelease();
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
  return makeRelease();
}

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    const next = waiters.shift();
    if (next) next();
  };
}

export function getLLMSemaphoreState(): { cap: number; inFlight: number; queued: number } {
  return { cap, inFlight, queued: waiters.length };
}

export function resetLLMSemaphoreForTests(): void {
  cap = resolveCap();
  inFlight = 0;
  waiters.length = 0;
}
