/**
 * Global semaphore that caps simultaneous LLM calls leaving this process.
 *
 * Why this exists: a single user turn can trigger an avalanche of LLM calls
 * inside the MCP child — cognitive extraction, contradiction detection (one
 * per existing record neighbour), graph extraction, focus-shift detection,
 * plus the 5-min sweeper backfilling old sensory rows. Add the CLI's chat
 * call hitting the SAME LM Studio endpoint and you can easily fire 10+
 * concurrent requests at one local GPU. On consumer hardware that triggers
 * either (a) LM Studio's auto-unload to free VRAM, (b) OOM, or (c) request
 * queue overflow — all of which surface to BrainRouter as "Model is
 * unloaded" or 500 errors.
 *
 * The fix is to serialize. This module exposes a simple promise-queue
 * semaphore with a configurable cap. Default is 2: one slot for the
 * user-facing extraction (foreground), one for opportunistic background
 * work (graph / contradiction / sweeper). Cloud deployments with a real
 * API backend (OpenAI, OpenRouter) can crank this up via the env var.
 *
 * Env knob:
 *   BRAINROUTER_LLM_MAX_CONCURRENT  (default 2; values < 1 disable the cap)
 */

const DEFAULT_CAP = 2;

function resolveCap(): number {
  const raw = process.env.BRAINROUTER_LLM_MAX_CONCURRENT;
  if (!raw) return DEFAULT_CAP;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return Number.POSITIVE_INFINITY;
  return parsed;
}

let cap = resolveCap();
let inFlight = 0;
const waiters: Array<() => void> = [];

/**
 * Acquire one slot. Returns a release function the caller must invoke when
 * the LLM call finishes (success OR failure). Use it like:
 *
 *   const release = await acquireLLMSlot();
 *   try { ...llm call... } finally { release(); }
 */
export async function acquireLLMSlot(): Promise<() => void> {
  if (!Number.isFinite(cap)) {
    // Cap disabled — passthrough.
    return () => {};
  }
  if (inFlight < cap) {
    inFlight++;
    return makeRelease();
  }
  // Otherwise wait in line.
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

/** Exposed for tests / diagnostics. */
export function getSemaphoreState(): { cap: number; inFlight: number; queued: number } {
  return { cap, inFlight, queued: waiters.length };
}

/**
 * Allow tests (or a future /config tool) to reset the cap and clear waiters
 * without restarting the process.
 */
export function resetSemaphoreForTests(): void {
  cap = resolveCap();
  inFlight = 0;
  waiters.length = 0;
}
