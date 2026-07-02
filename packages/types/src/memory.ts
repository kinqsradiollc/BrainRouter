/**
 * BrainRouter Memory Types
 *
 * Defines the types and boundaries for the BrainRouter memory engine.
 * Inspired by the reference architecture but scoped explicitly for MCP + Multi-tenant.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * This module was a ~1250-line god file. Its definitions now live in cohesive
 * sibling modules under `./memory/`, grouped by sub-domain. This file is a
 * re-export barrel that preserves the exact public surface — every name that
 * used to be `export`ed from here is still exported from here, unchanged.
 *
 *   ./memory/context.ts     — runtime multi-tenant context
 *   ./memory/records.ts     — sensory/cognitive records + workspace/project tags
 *   ./memory/session.ts     — federation sessions, inbox, delegation
 *   ./memory/operations.ts  — evidence, operations, import/export, diagnostics
 *   ./memory/search.ts      — vector/FTS search, recall, capture results
 *   ./memory/services.ts    — embedding/reranker/judge configs, users, LLM runner
 *   ./memory/scheduler.ts   — focus/identity/contradiction + scheduler state
 *   ./memory/graph.ts       — GraphRAG nodes/edges + analytics
 *   ./memory/agents.ts      — brain-agent registry, job queue, blackboard items
 *   ./memory/source.ts      — source documents + token-aware chunks
 *   ./memory/blackboard.ts  — blackboard commit pipeline
 *   ./memory/tree.ts        — hierarchical memory tree + vault mirror
 * ────────────────────────────────────────────────────────────────────────────
 */

export * from "./memory/context.js";
export * from "./memory/records.js";
export * from "./memory/session.js";
export * from "./memory/operations.js";
export * from "./memory/search.js";
export * from "./memory/services.js";
export * from "./memory/scheduler.js";
export * from "./memory/graph.js";
export * from "./memory/agents.js";
export * from "./memory/source.js";
export * from "./memory/blackboard.js";
export * from "./memory/tree.js";
