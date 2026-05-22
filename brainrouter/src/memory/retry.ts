export interface ExternalApiRetryOptions {
  label: string;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ExternalApiError";
  }
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 503]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableExternalError(error: unknown): boolean {
  if (error instanceof ExternalApiError) {
    return error.status !== undefined && RETRYABLE_HTTP_STATUSES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return false;
}

export async function retryExternalCall<T>(
  operation: () => Promise<T>,
  options: ExternalApiRetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableExternalError(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * (2 ** attempt);
      attempt += 1;
      console.error(`[BrainRouter] ${options.label} failed with a retryable error. Retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries}).`);
      await sleep(delayMs);
    }
  }
}

export async function fetchWithExternalRetry(
  input: string | URL | Request,
  init: RequestInit,
  options: ExternalApiRetryOptions
): Promise<Response> {
  return retryExternalCall(async () => {
    const response = await fetch(input, init);
    if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
      response.body?.cancel().catch(() => undefined);
      throw new ExternalApiError(`${options.label} failed with HTTP ${response.status} ${response.statusText}`, response.status);
    }
    return response;
  }, options);
}
