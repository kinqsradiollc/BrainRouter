export interface ResolveLLMTimeoutOptions {
  endpoint: string;
  requestedMs: number;
  envVarNames?: string[];
  localMinimumMs?: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the timeout (ms) for a generative LLM call (extraction / synthesis /
 * judge). Returns `0` for "no timeout — wait for the server", which is the
 * DEFAULT: a local LLM or a saturated backend can legitimately take minutes, and
 * aborting it mid-flight just drops the extraction / degrades recall. See
 * request-timeout.ts for the full contract.
 *
 * Bounds are OPT-IN, in priority order:
 *   1. An explicit per-task / global `*_TIMEOUT_MS` env (positive int) → that bound.
 *   2. `BRAINROUTER_LOCAL_LLM_MIN_TIMEOUT_MS` (positive int) for a LOCAL endpoint →
 *      a floor of `max(requestedMs, that)` — the legacy "local backends are slow"
 *      backstop, now off unless the operator sets it.
 *   3. Otherwise `0` (no timeout).
 */
export function resolveLLMTimeoutMs(options: ResolveLLMTimeoutOptions): number {
  const envVarNames = options.envVarNames ?? ["BRAINROUTER_LLM_TIMEOUT_MS"];
  for (const name of envVarNames) {
    const configured = parsePositiveInt(process.env[name]);
    if (configured !== undefined) {
      return configured;
    }
  }

  if (isLocalEndpoint(options.endpoint)) {
    const localFloor = options.localMinimumMs
      ?? parsePositiveInt(process.env.BRAINROUTER_LOCAL_LLM_MIN_TIMEOUT_MS);
    if (localFloor !== undefined && localFloor > 0) {
      return Math.max(options.requestedMs, localFloor);
    }
  }

  // No bound configured → wait for the server.
  return 0;
}

export function isExternalTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // Walk error.cause once — undici / fetch wrap their underlying
  // TimeoutError DOMException as `error.cause`, so a top-level "fetch
  // failed" error looks generic until you peek at .cause.name. Without
  // this, locally-hosted LLMs (LM Studio, Ollama) that genuinely
  // timed out fell into the "LLM extraction failed" loud-error path
  // and dumped a full stack trace into the CLI's terminal on every
  // turn, corrupting the Ink frame and looking like the CLI crashed.
  for (const candidate of [error, (error as { cause?: unknown }).cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = (candidate as { name?: unknown }).name;
    const message = (candidate as { message?: unknown }).message;
    if (
      name === "TimeoutError"
      || name === "AbortError"
      || (typeof message === "string" && /aborted due to timeout|operation was aborted|timeout|timed out/i.test(message))
    ) {
      return true;
    }
  }
  return false;
}

export function extractChatCompletionText(data: unknown): string | undefined {
  const choice = (data as any)?.choices?.[0];
  if (!choice || typeof choice !== "object") return undefined;

  const message = choice.message;
  const delta = choice.delta;
  const candidates = [
    message?.content,
    delta?.content,
    message?.reasoning_content,
    delta?.reasoning_content,
    message?.reasoning,
    delta?.reasoning,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  const emptyContent = candidates.find((candidate) => typeof candidate === "string");
  return typeof emptyContent === "string" ? emptyContent : undefined;
}
