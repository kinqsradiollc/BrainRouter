import type { MemoryType } from "./memory.js";

/**
 * Runtime list of every cognitive `MemoryType`, in pipeline-logical order.
 * Single source of truth for UIs that enumerate types (e.g. the dashboard
 * `/memories` type filter) so they can't drift from the union. Kept in
 * lockstep with the brain's `TYPE_CONFIGS` (a test asserts they match).
 * `satisfies` guarantees every entry is a valid `MemoryType`.
 *
 * Deliberately crypto-free (only a type-only import) so browser bundles can
 * import it without dragging in `node:crypto` from `memory.ts`'s hashers.
 */
export const COGNITIVE_MEMORY_TYPES = [
  "persona",
  "episodic",
  "instruction",
  "skill_context",
  "tool_preference",
  "codebase_fact",
  "api_contract",
  "data_model",
  "dependency_constraint",
  "environment_constraint",
  "architecture_decision",
  "implementation_decision",
  "design_constraint",
  "security_policy",
  "performance_baseline",
  "bug_finding",
  "debug_trace",
  "fix_summary",
  "verification_result",
  "failed_attempt",
  "regression_risk",
  "task_state",
  "handover_note",
  "blocked_reason",
  "review_comment",
  "release_note",
  "source_evidence",
  "artifact_reference",
  "file_history",
  "command_knowledge",
  "lesson",
] as const satisfies readonly MemoryType[];
