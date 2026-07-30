function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

export interface GatewayTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
}

/** Extract metadata-only token counters from an OpenAI Chat usage object. */
export function chatTokenUsage(value: unknown): GatewayTokenUsage | null {
  if (!isRecord(value)) return null;
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const usage = {
    inputTokens: tokenCount(value.prompt_tokens),
    outputTokens: tokenCount(value.completion_tokens),
    cachedInputTokens: tokenCount(details.cached_tokens),
    totalTokens: tokenCount(value.total_tokens),
  };
  return Object.values(usage).some((count) => count !== null) ? usage : null;
}

/** Extract metadata-only token counters from an OpenAI Responses usage object. */
export function responsesTokenUsage(value: unknown): GatewayTokenUsage | null {
  if (!isRecord(value)) return null;
  const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : {};
  const usage = {
    inputTokens: tokenCount(value.input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    cachedInputTokens: tokenCount(details.cached_tokens),
    totalTokens: tokenCount(value.total_tokens),
  };
  return Object.values(usage).some((count) => count !== null) ? usage : null;
}
