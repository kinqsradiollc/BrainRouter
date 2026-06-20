export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateTokensForJson(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}
