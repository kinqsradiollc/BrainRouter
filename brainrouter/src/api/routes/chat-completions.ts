// OpenAI-compatible /v1/chat/completions endpoint, memory-augmented.
//
// This file is a thin re-export barrel. The implementation was split into
// cohesive per-domain modules under ./chat-completions/ (request parsing +
// memory briefing, provider dispatch + route handlers, SSE streaming, reasoning
// response shaping, and turn capture). The public surface is unchanged.

export { chatCompletionsRouter } from "./chat-completions/router.js";
export { getMemoryStatusForUser } from "./chat-completions/briefing.js";
export { StreamingReasoningRewriter, parseAndFormatThink } from "./chat-completions/reasoning.js";
