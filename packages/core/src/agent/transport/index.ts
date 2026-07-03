// Transport concern: the LLM wire layer — payload types, request-format
// resolution, Chat-Completions/Responses builders, the callOpenAI network calls,
// and the native (Anthropic/Gemini) wire adapters. Barrel for navigability.
export * from './llmTransport.js';
export * from './nativeProviders.js';
