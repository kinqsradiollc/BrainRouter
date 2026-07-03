// Barrel for the agent `transport` concern: LLM wire transport plumbing and the
// native (non-OpenAI-compat) provider adapters. Sub-structure only — no
// behavior change; modules keep their original public surface.
export * from './llmTransport.js';
export * from './nativeProviders.js';
