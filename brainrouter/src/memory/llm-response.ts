export interface ResolveLLMTimeoutOptions {
  endpoint: string;
  requestedMs: number;
  envVarNames?: string[];
  localMinimumMs?: number;
}

const LOCAL_LLM_MIN_TIMEOUT_MS = 10 * 60 * 1000;

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

export function resolveLLMTimeoutMs(options: ResolveLLMTimeoutOptions): number {
  const envVarNames = options.envVarNames ?? ["BRAINROUTER_LLM_TIMEOUT_MS"];
  for (const name of envVarNames) {
    const configured = parsePositiveInt(process.env[name]);
    if (configured !== undefined) {
      return configured;
    }
  }

  if (isLocalEndpoint(options.endpoint)) {
    return Math.max(options.requestedMs, options.localMinimumMs ?? LOCAL_LLM_MIN_TIMEOUT_MS);
  }

  return options.requestedMs;
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
