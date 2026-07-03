// Tool-dispatch concern: the local-tool executor plus tool-result presentation,
// parallel-safety, call recovery/pairing, denial, and MCP approval helpers.
// Barrel for navigability.
export * from './executeLocalTool.impl.js';
export * from './toolSafety.js';
export * from './toolSummary.js';
export * from './toolCallRecovery.js';
export * from './denialMessage.js';
export * from './mcpApproval.js';
