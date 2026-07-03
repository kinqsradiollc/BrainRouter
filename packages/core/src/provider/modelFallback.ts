/**
 * PARITY-E3 (0.4.2) — runtime model fallback.
 *
 * When a turn's LLM call fails because the configured model doesn't exist
 * at the active endpoint (a 404 / "model not found" — not a transient
 * network/rate-limit error), switch the session to `cli.fallbackModel` and
 * retry ONCE. Pure helpers so the matcher + the should-switch guard test
 * without a live provider.
 */

/** True when an error message looks like "this model isn't available here". */
export function isModelNotFoundError(message: string): boolean {
  const m = (message ?? '').toLowerCase();
  // Common OpenAI-compatible shapes: 404 + model, "model not found",
  // "does not exist", "unknown model", "no such model", "invalid model".
  if (/\bmodel[_ ]?not[_ ]?found\b/.test(m)) return true;
  if (/(unknown|no such|invalid|unsupported) model/.test(m)) return true;
  if (/model .*(not found|does not exist|is not available|unavailable)/.test(m)) return true;
  if (/\b404\b/.test(m) && /model/.test(m)) return true;
  return false;
}

/**
 * Whether to fall back: a fallback is configured, it differs from the
 * current model, and we haven't already tried it this turn (prevents a
 * fallback→fail→fallback loop).
 */
export function shouldFallbackModel(
  currentModel: string,
  fallbackModel: string | undefined | null,
  alreadyTried: boolean,
): boolean {
  if (alreadyTried) return false;
  const fb = (fallbackModel ?? '').trim();
  return fb.length > 0 && fb !== currentModel;
}

/**
 * CC-CONFIG-A2 — pick the next model from an ORDERED fallback chain.
 *
 * Given the ordered `chain` (already resolved by `resolveFallbackModels`), the
 * `currentModel`, and the set of models already tried this turn, returns the first
 * chain entry that is neither the current model nor already tried — or `null` when
 * the chain is exhausted. Walking the chain in order (rather than a single fixed
 * fallback) lets a model-not-found cascade through several candidates.
 */
export function nextFallbackModel(
  currentModel: string,
  chain: readonly string[] | undefined,
  triedModels: ReadonlySet<string>,
): string | null {
  const current = (currentModel ?? '').trim();
  for (const raw of chain ?? []) {
    const candidate = (raw ?? '').trim();
    if (!candidate) continue;
    if (candidate === current) continue;
    if (triedModels.has(candidate)) continue;
    return candidate;
  }
  return null;
}
