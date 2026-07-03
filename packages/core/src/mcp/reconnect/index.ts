// Barrel — reconnect/backoff math + connectivity probe used across the MCP
// client and the agent LLM call loop. Grouped into its own concern folder so
// the pure backoff/header helpers stay separable from the live transport.
export * from './reconnect.js';
