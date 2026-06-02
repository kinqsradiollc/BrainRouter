import type { AccessMode, ActionKind } from '../../runtime/exec/execPolicy.js';

/**
 * CODEX-TOOL-REGISTRY (0.4.7) — one declarative contract per access-gated tool.
 *
 * Before this, a tool's facts lived in FOUR separate places that could drift:
 *   - model-visible spec      → `LOCAL_TOOLS` (tools/specs.ts)
 *   - exposure per access mode → `Agent.allowedToolsForAccess()` (hard-coded sets)
 *   - execution action kind    → `actionKindForTool()` (execPolicy.ts)
 *   - parallel-dispatch safety → `PARALLEL_SAFE_LOCAL_TOOLS` (toolSafety.ts)
 * That drift was the root cause of the REVIEW-FIX bug (a tool exposed in read
 * mode but action-kind'd as `child_write`, so it was denied). Codex keeps one
 * `ToolExecutor` entry per tool (`tool_executor.rs:35/51`).
 *
 * This registry is the single source for the access-gated surface: the agent's
 * exposure set is now GENERATED from `accessTier` here, and a guard test
 * (`tool-registry.test.ts`) fails on any registry↔policy↔parallel mismatch.
 *
 * Scope note: the dynamic worker tools (`spawn_worker_thread`, `wait_worker`, …)
 * are a separate, goal-scoped surface that isn't access-mode gated here, so they
 * are intentionally NOT in this table; the guard test treats them as a known
 * exception rather than a missing entry.
 */
export interface LocalToolEntry {
  name: string;
  /** Lowest access mode that exposes the tool (read ⊂ write ⊂ shell). */
  accessTier: AccessMode;
  /** Execution action kind — must equal `actionKindForTool(name)`. */
  actionKind: ActionKind;
  /** Safe to dispatch concurrently within one assistant message. */
  parallelSafe: boolean;
}

export const LOCAL_TOOL_REGISTRY: LocalToolEntry[] = [
  // --- read tier: always available (no workspace mutation) ----------------
  { name: 'read_file', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'list_dir', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'grep_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'glob_files', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'fetch_url', accessTier: 'read', actionKind: 'network', parallelSafe: true },
  { name: 'web_search', accessTier: 'read', actionKind: 'read_only', parallelSafe: true },
  { name: 'lsp', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'update_plan', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'goal_complete', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'goal_blocked', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'ask_user_choice', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // Orchestration surface (added dynamically as specs, but access-gated here).
  // NB: child-spawn action kind is resolved per-call from the requested child
  // `access` (REVIEW-FIX); `child_write` is the name-only default they share.
  { name: 'task_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true },
  { name: 'delegate_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: true },
  { name: 'spawn_agent', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  { name: 'spawn_agents', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  { name: 'list_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'wait_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'wait_agents', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'read_agent_transcript', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'close_agent', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  { name: 'route_task', accessTier: 'read', actionKind: 'read_only', parallelSafe: false },
  // WF-TOOL — run_workflow launches a fan-out of child agents (child_write), like spawn_*.
  { name: 'run_workflow', accessTier: 'read', actionKind: 'child_write', parallelSafe: false },
  // --- write tier: + structured file edits --------------------------------
  { name: 'write_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'edit_file', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  { name: 'apply_patch', accessTier: 'write', actionKind: 'file_edit', parallelSafe: false },
  // --- shell tier: + command execution ------------------------------------
  { name: 'run_command', accessTier: 'shell', actionKind: 'shell', parallelSafe: false },
];

const TIER_RANK: Record<AccessMode, number> = { read: 0, write: 1, shell: 2 };

/**
 * The model-visible tool set for an access mode, GENERATED from the registry:
 * every tool whose `accessTier` is at or below `mode`. This is the single
 * definition `Agent.allowedToolsForAccess()` delegates to.
 */
export function registryAllowedTools(mode: AccessMode): Set<string> {
  const ceiling = TIER_RANK[mode];
  return new Set(LOCAL_TOOL_REGISTRY.filter((t) => TIER_RANK[t.accessTier] <= ceiling).map((t) => t.name));
}

/** The parallel-safe local tools, generated from the registry. */
export function registryParallelSafeLocal(): Set<string> {
  return new Set(LOCAL_TOOL_REGISTRY.filter((t) => t.parallelSafe).map((t) => t.name));
}

/** Lookup an entry by tool name. */
export function registryEntry(name: string): LocalToolEntry | undefined {
  return LOCAL_TOOL_REGISTRY.find((t) => t.name === name);
}
