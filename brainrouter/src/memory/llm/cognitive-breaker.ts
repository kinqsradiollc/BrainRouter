/**
 * Circuit breaker for the GENERATIVE / cognitive LLM calls (extraction,
 * contradiction check, graph extraction, focus-shift detection, distillation).
 *
 * Why: when the configured generative endpoint goes down (the free
 * `nemotron-3-ultra-free` 502/timeout cascade from the logs), every cognitive
 * stage independently burns its full retry+backoff+timeout budget before
 * failing — many minutes of wasted wall-clock and queue pile-up per turn. A
 * shared breaker lets the first few failures open the circuit so the rest of the
 * chain fast-fails instead. Records simply stay queued and the sweeper retries
 * after the cooldown, so nothing is lost.
 *
 * This mirrors the reranker circuit breaker (store/reranker.ts) but is a
 * SEPARATE instance with its own env tuning — different backend, different
 * failure profile. Module-singleton state, shared across all ModelLLMRunner
 * instances and task IDs (one generative backend serves them all).
 */

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

let consecutiveFailures = 0;
let breakerOpenUntil = 0;

export function cognitiveBreakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.BRAINROUTER_COGNITIVE_BREAKER_THRESHOLD ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_THRESHOLD;
}

export function cognitiveBreakerCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.BRAINROUTER_COGNITIVE_BREAKER_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_COOLDOWN_MS;
}

/** True while the circuit is open (cooling down after repeated failures). */
export function cognitiveBreakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

/** Record a successful generative call — closes the circuit. */
export function recordCognitiveSuccess(): void {
  if (consecutiveFailures > 0 || breakerOpenUntil > 0) {
    console.error("[BrainRouter] Cognitive LLM recovered; circuit closed.");
  }
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

/** Record a failed generative call — opens the circuit at the threshold. */
export function recordCognitiveFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= cognitiveBreakerThreshold() && Date.now() >= breakerOpenUntil) {
    const cooldownMs = cognitiveBreakerCooldownMs();
    breakerOpenUntil = Date.now() + cooldownMs;
    console.error(
      `[BrainRouter] Cognitive LLM circuit opened after ${consecutiveFailures} consecutive failures; `
      + `skipping cognitive LLM calls for ${Math.round(cooldownMs / 1000)}s.`,
    );
  }
}

/** Reset breaker state — for tests / diagnostics. */
export function resetCognitiveBreakerForTests(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}
